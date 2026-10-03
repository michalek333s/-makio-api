import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  fileWaitlistAdd,
  fileWaitlistCount,
  isMissingWaitlistTableError,
} from '../services/landingWaitlistStore.js';

const router = Router();

const WAITLIST_CAP = 100;

const waitlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Příliš mnoho pokusů o registraci. Zkuste to za hodinu.' },
});

const PAIN_POINTS = new Set(['wsdp', 'aml', 'smlouvy', 'nabery', 'crm']);

let missingTableWarned = false;

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function getSupabaseConfig() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

function productionUnavailable(res, extra = {}) {
  return res.status(503).json({
    error: 'Waitlist není připojený k databázi. Spusťte migraci 0043_landing_waitlist_ensure.sql.',
    configured: false,
    ...extra,
  });
}

function supabaseHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
}

async function fetchCount(cfg) {
  const url = `${cfg.supabaseUrl}/rest/v1/landing_waitlist?select=id`;
  const res = await fetch(url, {
    headers: {
      ...supabaseHeaders(cfg.serviceKey),
      Prefer: 'count=exact',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `count HTTP ${res.status}`);
  }
  const range = res.headers.get('content-range') || '';
  const match = range.match(/\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function warnMissingTableOnce(err) {
  if (missingTableWarned) return;
  missingTableWarned = true;
  console.warn(
    '[waitlist] Tabulka landing_waitlist chybí — používám lokální soubor. V Supabase SQL spusťte migraci 0019 nebo 0043.',
    err?.message ? String(err.message).slice(0, 120) : '',
  );
}

router.get('/count', async (_req, res) => {
  const cfg = getSupabaseConfig();
  if (!cfg) {
    if (isProduction()) return productionUnavailable(res, { remaining: WAITLIST_CAP, cap: WAITLIST_CAP, count: 0 });
    const count = fileWaitlistCount();
    return res.json({
      count,
      cap: WAITLIST_CAP,
      remaining: Math.max(0, WAITLIST_CAP - count),
      configured: true,
      storage: 'file',
    });
  }

  try {
    const count = await fetchCount(cfg);
    return res.json({
      count,
      cap: WAITLIST_CAP,
      remaining: Math.max(0, WAITLIST_CAP - count),
      configured: true,
      storage: 'supabase',
    });
  } catch (err) {
    if (isMissingWaitlistTableError(err)) {
      warnMissingTableOnce(err);
      if (isProduction()) return productionUnavailable(res, { remaining: WAITLIST_CAP, cap: WAITLIST_CAP, count: 0 });
      const count = fileWaitlistCount();
      return res.json({
        count,
        cap: WAITLIST_CAP,
        remaining: Math.max(0, WAITLIST_CAP - count),
        configured: true,
        storage: 'file',
        warning: 'Supabase tabulka chybí — zápis jde do lokálního souboru do doby migrace.',
      });
    }
    console.error('[waitlist] count error:', err.message);
    return res.json({
      count: 0,
      cap: WAITLIST_CAP,
      remaining: WAITLIST_CAP,
      configured: false,
      warning: 'Waitlist dočasně nedostupný.',
    });
  }
});

router.post('/', waitlistLimiter, async (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const painPoint = String(req.body?.painPoint || '').trim();
  const gdprConsent = Boolean(req.body?.gdprConsent);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Zadejte platný pracovní e-mail.' });
  }

  if (!gdprConsent) {
    return res.status(400).json({ error: 'Pro registraci je nutný souhlas se zpracováním údajů.' });
  }

  if (painPoint && !PAIN_POINTS.has(painPoint)) {
    return res.status(400).json({ error: 'Neplatná volba z kvízu.' });
  }

  const cfg = getSupabaseConfig();
  if (!cfg) {
    if (isProduction()) return productionUnavailable(res);
    try {
      const newCount = fileWaitlistAdd({ email, painPoint, gdprConsent });
      return res.json({
        ok: true,
        count: newCount,
        remaining: Math.max(0, WAITLIST_CAP - newCount),
        cap: WAITLIST_CAP,
        storage: 'file',
      });
    } catch (e) {
      if (e?.code === 'DUPLICATE') {
        return res.status(409).json({ error: 'Tento e-mail je už registrovaný. Brzy se ozveme.' });
      }
      throw e;
    }
  }

  try {
    const currentCount = await fetchCount(cfg);

    if (currentCount >= WAITLIST_CAP) {
      return res.status(409).json({
        error: 'Kapacita beta programu je naplněna. Ozvěte se na info@makio.cz.',
        full: true,
      });
    }

    const insertRes = await fetch(`${cfg.supabaseUrl}/rest/v1/landing_waitlist`, {
      method: 'POST',
      headers: supabaseHeaders(cfg.serviceKey),
      body: JSON.stringify({
        email,
        pain_point: painPoint || null,
        gdpr_consent: gdprConsent,
        source: 'landing',
      }),
    });

    if (!insertRes.ok) {
      const body = await insertRes.text();
      if (insertRes.status === 409 || body.includes('23505') || body.includes('duplicate')) {
        return res.status(409).json({ error: 'Tento e-mail je už registrovaný. Brzy se ozveme.' });
      }
      throw new Error(body || `insert HTTP ${insertRes.status}`);
    }

    const newCount = currentCount + 1;

    return res.json({
      ok: true,
      count: newCount,
      remaining: Math.max(0, WAITLIST_CAP - newCount),
      cap: WAITLIST_CAP,
      storage: 'supabase',
    });
  } catch (err) {
    if (isMissingWaitlistTableError(err)) {
      warnMissingTableOnce(err);
      if (isProduction()) return productionUnavailable(res);
      try {
        const newCount = fileWaitlistAdd({ email, painPoint, gdprConsent });
        if (newCount > WAITLIST_CAP) {
          return res.status(409).json({
            error: 'Kapacita beta programu je naplněna. Ozvěte se na info@makio.cz.',
            full: true,
          });
        }
        return res.json({
          ok: true,
          count: newCount,
          remaining: Math.max(0, WAITLIST_CAP - newCount),
          cap: WAITLIST_CAP,
          storage: 'file',
          message: 'Registrace přijata (lokální úložiště — doplňte migraci landing_waitlist).',
        });
      } catch (e) {
        if (e?.code === 'DUPLICATE') {
          return res.status(409).json({ error: 'Tento e-mail je už registrovaný. Brzy se ozveme.' });
        }
      }
    }
    console.error('[waitlist] insert error:', err.message);
    return res.status(500).json({ error: 'Registraci se nepodařilo uložit. Zkuste to prosím znovu.' });
  }
});

export default router;
