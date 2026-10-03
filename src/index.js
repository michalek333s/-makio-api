import './loadEnv.js';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import propertyRoutes from './routes/property.js';
import aiRoutes from './routes/ai.js';
import crmRoutes from './routes/crm.js';
import contractRoutes from './routes/contracts.js';
import checksRoutes from './routes/checks.js';
import radarRoutes from './routes/radar.js';
import radarWebhookRoutes from './routes/radarWebhook.js';
import radarWatchdogRoutes from './routes/radarWatchdog.js';
import amlRoutes from './routes/aml.js';
import amlDueDiligenceRoutes from './routes/amlDueDiligence.js';
import zoomRoutes from './routes/zoom.js';
import calendarRoutes from './routes/calendar.js';
import signingRoutes from './routes/signing.js';
import waitlistRoutes from './routes/waitlist.js';
import stagingVideoRoutes from './routes/stagingVideo.js';
import reelsRoutes from './routes/reels.js';
import reelsStudioRoutes from './routes/reelsStudio.js';
import { aiRouteLimiter, radarRouteLimiter } from './middleware/rateLimits.js';
import { requireAuth, isAuthEnforced } from './middleware/requireAuth.js';
import { resolveCorsOrigin } from './lib/corsOrigin.js';
import { syncEuSanctionsCache } from './services/euSanctions.js';
import { getGeopasCacheStats } from './services/geopasCacheStore.js';
import { startRadarBackgroundScheduler, queueBackgroundEnrich } from './services/radarBackgroundEnrich.js';
import { startRadarLivePollScheduler } from './services/radarPollConfig.js';
import { hydrateRadarV2FromSupabase } from './services/radarV2Store.js';
import { getRoutingSummary } from './config/aiRouting.js';
import { getCapabilityStatus } from './services/capabilityStatus.js';
import { assertProductionGuards } from './lib/productionGuards.js';
import { getClaudeUsageSnapshot } from './services/claudeBudget.js';
import { REEL_MEDIA_DIR } from './services/reelMediaStore.js';
import { mkdirSync } from 'fs';

const app = express();
const PORT = process.env.PORT || 3001;

try {
  mkdirSync(REEL_MEDIA_DIR, { recursive: true });
} catch {
  /* ignore */
}

// Za reverse proxy (nginx) kvůli správné IP u rate limitu
if (process.env.TRUST_PROXY === '1' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// ─── Bezpečnost ───────────────────────────────────────────────────────────────
app.use(helmet());
// Lokálně Vite mění port (5173 → 5174 → …); pevně jen :5173 láme CORS („Failed to fetch“).
// V dev povolíme libovolný origin; ve výrobě FRONTEND_URL / FRONTEND_URLS (app + landing).
const corsOrigin = resolveCorsOrigin();
if (process.env.NODE_ENV === 'production' && corsOrigin === false) {
  console.error('[cors] FRONTEND_URL chybí v production — CORS fail-closed (žádný origin).');
}
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: '10mb' })); // 10mb kvůli base64 fotkám

// Lokální finální MP4 (fallback když Supabase bucket nepovolí video/mp4)
app.use(
  '/media/reels',
  express.static(REEL_MEDIA_DIR, {
    fallthrough: false,
    setHeaders(res) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  }),
);

// ─── Rate Limiting ─────────────────────────────────────────────────────────────
// Globální limit — ochrana před zneužitím
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minut
  max: 300,
  skip: (req) => process.env.NODE_ENV !== 'production' && /^127\.|^::1$|^::ffff:127\./.test(String(req.ip || '')),
  message: { error: 'Příliš mnoho požadavků, zkuste to za chvíli.' },
});

// Přísnější limit pro drahé GeoPas volání
const geopasLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuta
  max: 20,
  message: { error: 'Limit analýz nemovitostí — max 20 za minutu.' },
});

app.use(globalLimiter);

// ─── Auth (Supabase JWT) — health + waitlist zůstávají veřejné ─────────────────
app.use('/api', requireAuth);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/property', geopasLimiter, propertyRoutes);
app.use('/api/ai', aiRouteLimiter, aiRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/checks', checksRoutes);
app.use('/api/radar', radarRouteLimiter, radarRoutes);
app.use('/api/radar', radarRouteLimiter, radarWatchdogRoutes);
app.use('/api/webhooks/radar', radarWebhookRoutes);
app.use('/api/aml', amlDueDiligenceRoutes);
app.use('/api/aml', amlRoutes);
app.use('/api/zoom', zoomRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/signing', signingRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/staging', stagingVideoRoutes);
app.use('/api/reels', reelsRoutes);
app.use('/api/reels', reelsStudioRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
// Ve výrobě bez HEALTH_DETAIL=1 nevracíme mapu služeb (snížení informačního odhalení)
app.get('/api/health', (req, res) => {
  const detailed =
    process.env.NODE_ENV !== 'production' || process.env.HEALTH_DETAIL === '1';
  if (!detailed) {
    return res.json({ status: 'ok', version: '1.0.0' });
  }
  res.json({
    status: 'ok',
    version: '1.0.0',
    services: {
      geopas: !!process.env.GEOPAS_API_KEY,
      geopasAgent: !!(process.env.GEOPAS_API_KEY && (process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY)),
      gemini: !!process.env.GEMINI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      apify: !!process.env.APIFY_TOKEN,
      supabase: !!process.env.SUPABASE_URL,
      rejstriky: !!(process.env.REJSTRIKY_USERNAME && process.env.REJSTRIKY_PASSWORD),
      zoom: !!(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET),
      decor8: !!process.env.DECOR8_API_KEY,
      higgsfield: !!(process.env.HF_CREDENTIALS || process.env.HIGGSFIELD_CREDENTIALS || (process.env.HF_API_KEY && process.env.HF_API_SECRET)),
      opensanctions: !!process.env.OPENSANCTIONS_API_KEY,
    },
    aiRouting: getRoutingSummary(),
    claudeUsageToday: getClaudeUsageSnapshot(),
    geopasCache: getGeopasCacheStats(),
    authEnforced: isAuthEnforced(),
  });
});

/** Přihlášený makléř — co je živé vs. co chybí (bez tajných hodnot). */
app.get('/api/status', (req, res) => {
  res.json(getCapabilityStatus());
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
  const status = Number(err.status) >= 400 && Number(err.status) < 600 ? err.status : 500;
  res.status(status).json({
    error: err.message || 'Interní chyba serveru',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

assertProductionGuards();

app.listen(PORT, () => {
  console.log(`✅ Makio Backend běží na http://localhost:${PORT}`);
  console.log(`   GeoPas API: ${process.env.GEOPAS_API_KEY ? '✅ připojen' : '❌ chybí klíč'}`);
  console.log(`   Gemini API: ${process.env.GEMINI_API_KEY ? '✅ připojen' : '❌ chybí klíč'}`);
  const route = getRoutingSummary();
  console.log(
    `   AI routing: chat=${route.chatProvider}, geopas=${route.geopasChatMode}, claude=${route.capabilities.claude ? '✅' : '—'}`,
  );
  console.log(`   OpenAI API: ${process.env.OPENAI_API_KEY ? '✅ připojen' : '❌ chybí klíč'}`);
  console.log(`   Decor8:     ${process.env.DECOR8_API_KEY ? '✅ staging API' : '❌ chybí DECOR8_API_KEY'}`);
  console.log(`   Supabase:   ${process.env.SUPABASE_URL ? '✅ připojen' : '❌ chybí URL'}`);
  console.log(`   API auth:   ${isAuthEnforced() ? '✅ JWT vyžadován' : '⚠️ vypnuto (AUTH_DISABLED / chybí Supabase)'}`);
  console.log(`   Rejstriky:  ${process.env.REJSTRIKY_USERNAME ? '✅ přihlášení v .env' : '❌ chybí REJSTRIKY_*'}`);
  console.log(
    `   OpenSanctions: ${process.env.OPENSANCTIONS_API_KEY ? '✅ AML Match API' : '❌ chybí OPENSANCTIONS_API_KEY'}`,
  );
  console.log(
    `   ISIR:         ${
      process.env.INSHLIDAC_EMAIL || process.env.REJSTRIKY_USERNAME
        ? '✅ přihlášení v .env'
        : '❌ chybí INSHLIDAC_* / REJSTRIKY_*'
    }`,
  );
  console.log(`   Apify:      ${process.env.APIFY_TOKEN ? '✅ token v .env' : '❌ chybí APIFY_TOKEN (Radar)'}`);
  const cap = getCapabilityStatus();
  console.log(`   Provoz:     ${cap.live ? '✅ jádro živé' : '⚠️ neúplné'} — ${cap.hint}`);
  console.log(
    `   Zoom:       ${
      process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET
        ? '✅ S2S OAuth v .env'
        : '❌ chybí ZOOM_* (videohovory bez auto odkazu)'
    }`,
  );
});

// Fallback scheduler: refresh EU sanctions cache daily on backend.
const EU_SANCTIONS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
syncEuSanctionsCache()
  .then((meta) => {
    console.log(`   EU sanctions cache: ✅ ${meta.count} záznamů (${meta.source})`);
  })
  .catch((error) => {
    console.warn(`   EU sanctions cache: ⚠️ ${error?.message || 'sync failed'}`);
  });

setInterval(() => {
  syncEuSanctionsCache()
    .then((meta) => {
      console.log(`   EU sanctions cache refresh: ✅ ${meta.count} záznamů`);
    })
    .catch((error) => {
      console.warn(`   EU sanctions cache refresh: ⚠️ ${error?.message || 'sync failed'}`);
    });
}, EU_SANCTIONS_REFRESH_INTERVAL_MS);

startRadarBackgroundScheduler();
startRadarLivePollScheduler((region, propertyType, opts) =>
  queueBackgroundEnrich(region, propertyType, opts),
);
hydrateRadarV2FromSupabase()
  .then((meta) => {
    if (meta.blacklist) console.log(`   Radar v2 blacklist: ${meta.blacklist} telefonů`);
  })
  .catch((e) => console.warn(`   Radar v2 hydrate: ${e.message}`));

export default app;
