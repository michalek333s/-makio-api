/**
 * Radar enrich na pozadí — Apify běhy + polling, scan pak okamžitě z cache.
 */

import { startSrealityApifyScrape } from './srealityApify.js';
import { startRadarScrape } from './apify.js';
import { startBazosScrape } from './bazos.js';
import { startFacebookMarketplaceScrape } from './facebookMarketplace.js';
import { pullEnrichRuns } from './radarEnrichPull.js';
import { getListingCacheMeta } from './radarCacheStore.js';
import { REGION_IDS } from './sreality.js';
import { pullLatestApifyIntoCache, isApifyQuotaError, shouldSalvageLastApifyRun } from './apifyLastRun.js';
import { invalidateRadarScanMemory } from './radarScanMemory.js';

const jobs = new Map();
const POLL_MS = Number(process.env.RADAR_BG_POLL_MS || 15_000);
let pollTimer = null;

/** Po Apify monthly limit — nezkoušet startovat nové běhy (šetří logy i zbytečné API). */
let apifyQuotaUntil = 0;

export function noteApifyQuotaHit(hours = 6) {
  const h = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Number(hours) : 6;
  apifyQuotaUntil = Date.now() + h * 3600_000;
}

export function isApifyQuotaCoolingDown() {
  return Date.now() < apifyQuotaUntil;
}

export function getApifyQuotaCooldownMs() {
  return Math.max(0, apifyQuotaUntil - Date.now());
}

function jobKey(region, propertyType) {
  return `${region}::${propertyType}`;
}

function parseList(envVal, fallback) {
  const raw = String(envVal || fallback).trim();
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getBackgroundEnrichConfig() {
  const refreshHours = Number(process.env.RADAR_BG_REFRESH_HOURS || 6);
  return {
    enabled: process.env.RADAR_BG_ENRICH !== '0',
    regions: parseList(process.env.RADAR_BG_REGIONS, 'Moravskoslezský'),
    propertyTypes: parseList(process.env.RADAR_BG_PROPERTY_TYPES, 'byty'),
    refreshMs:
      Number.isFinite(refreshHours) && refreshHours > 0 ? refreshHours * 3600_000 : 6 * 3600_000,
    pollMs: POLL_MS,
  };
}

async function startApifyRuns(region, propertyType, offerType = 'prodej', maxListings = null) {
  // Úspora: CZ Reality jen Sreality (Bezrealitky v Radaru nejsou).
  const useDedicatedSreality = process.env.RADAR_DEDICATED_SREALITY === '1';
  const srealityMax = Number(
    maxListings ?? process.env.RADAR_SREALITY_MAX_LISTINGS ?? 100,
  );
  const czMax = Number(
    maxListings ?? process.env.RADAR_CZ_MAX_LISTINGS ?? process.env.RADAR_BEZREALITKY_MAX_LISTINGS ?? 100,
  );
  const czPortals = parseList(process.env.RADAR_CZ_PORTALS, 'sreality').filter(
    (p) => p && p !== 'bezrealitky',
  );
  const warnings = [];
  let srealityRunId = null;
  let czRealityRunId = null;
  let bazosRunId = null;
  let facebookRunId = null;

  const [srealityRes, czRes, bazosRes, fbRes] = await Promise.allSettled([
    useDedicatedSreality
      ? startSrealityApifyScrape({ region, propertyType, offerType, maxListings: srealityMax })
      : Promise.resolve(null),
    !useDedicatedSreality && czPortals.length
      ? startRadarScrape({
          portals: czPortals,
          propertyType,
          regions: [region],
          maxListings: czMax,
          enableHistory: false,
        })
      : Promise.resolve(null),
    process.env.RADAR_BAZOS_ENABLED === '0'
      ? Promise.resolve(null)
      : startBazosScrape({ region, propertyType }),
    process.env.RADAR_FB_ENABLED === '0'
      ? Promise.resolve(null)
      : startFacebookMarketplaceScrape({ region, propertyType }),
  ]);

  if (useDedicatedSreality) {
    if (srealityRes.status === 'fulfilled') srealityRunId = srealityRes.value;
    else warnings.push(`Sreality: ${srealityRes.reason?.message || 'selhalo'}`);
  }

  if (czRes.status === 'fulfilled') czRealityRunId = czRes.value;
  else warnings.push(`CZ Reality (${czPortals.join('+')}): ${czRes.reason?.message || 'selhalo'}`);

  if (bazosRes.status === 'fulfilled') {
    bazosRunId = bazosRes.value;
    if (!bazosRunId) warnings.push('Bazoš vypnutý.');
  } else if (bazosRes.reason?.code === 'BAZOS_PERMISSIONS') {
    warnings.push(bazosRes.reason.message);
  } else {
    warnings.push(`Bazoš: ${bazosRes.reason?.message || 'selhalo'}`);
  }

  if (fbRes.status === 'fulfilled') {
    facebookRunId = fbRes.value;
    if (!facebookRunId && process.env.RADAR_FB_ENABLED !== '0') {
      warnings.push('Facebook Marketplace vypnutý nebo bez URL pro region.');
    }
  } else if (fbRes.reason?.code === 'FB_PERMISSIONS') {
    warnings.push(fbRes.reason.message);
  } else if (process.env.RADAR_FB_ENABLED !== '0') {
    warnings.push(`Facebook: ${fbRes.reason?.message || 'selhalo'}`);
  }

  if (!srealityRunId && !czRealityRunId) {
    const err = new Error(
      `Nepodařilo se spustit žádný Apify běh. ${warnings.slice(0, 3).join(' ')}`.trim(),
    );
    err.warnings = warnings;
    const blob = warnings.join(' ');
    if (/403|quota|hard limit|dataset-locked|platform-feature-disabled/i.test(blob)) {
      err.status = 403;
      err.code = 'APIFY_QUOTA';
    }
    throw err;
  }

  return { srealityRunId, czRealityRunId, bazosRunId, facebookRunId, warnings };
}

async function pollJob(key) {
  const job = jobs.get(key);
  if (!job || job.status !== 'running') return;

  try {
    const result = await pullEnrichRuns({
      srealityRunId: job.srealityRunId,
      czRealityRunId: job.czRealityRunId,
      bazosRunId: job.bazosRunId,
      facebookRunId: job.facebookRunId,
      region: job.region,
      propertyType: job.propertyType,
    });

    job.lastPollAt = Date.now();
    job.runMeta = result.runMeta;
    job.warnings = result.warnings;

    if (result.pending) return;

    if (result.ok) {
      job.status = 'done';
      job.finishedAt = Date.now();
      job.stored = result.stored || 0;
      job.total = result.total || 0;
      job.empty = Boolean(result.empty);
      if (!result.empty) {
        invalidateRadarScanMemory(job.region, job.propertyType);
      }
      if (result.empty) {
        console.log(
          `[Radar BG] Prázdný výsledek ${job.region}/${job.propertyType} — cache beze změny (${result.message || '0 inzerátů'})`,
        );
      } else {
        console.log(
          `[Radar BG] Hotovo ${job.region}/${job.propertyType}: ${result.total} inzerátů v cache`,
        );
      }
    } else {
      job.status = 'failed';
      job.finishedAt = Date.now();
      job.error = result.message || 'Enrich selhal';
      console.warn(`[Radar BG] Selhalo ${job.region}/${job.propertyType}:`, job.error);
    }
  } catch (e) {
    job.status = 'failed';
    job.finishedAt = Date.now();
    job.error = e.message;
    console.warn(`[Radar BG] Poll chyba ${key}:`, e.message);
  }
}

function ensurePollLoop() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const running = [...jobs.values()].filter((j) => j.status === 'running');
    if (!running.length) return;
    for (const job of running) {
      await pollJob(jobKey(job.region, job.propertyType));
    }
  }, POLL_MS);
}

export async function queueBackgroundEnrich(
  region,
  propertyType,
  { force = false, reason = 'manual' } = {},
) {
  const cfg = getBackgroundEnrichConfig();
  if (!cfg.enabled && !force) {
    return { queued: false, reason: 'disabled' };
  }
  if (!REGION_IDS[region]) {
    return { queued: false, reason: 'unknown_region' };
  }

  if (!force && isApifyQuotaCoolingDown()) {
    return {
      queued: false,
      reason: 'apify_quota_cooldown',
      code: 'APIFY_QUOTA',
      cooldownMs: getApifyQuotaCooldownMs(),
      message:
        'Apify měsíční limit — nové scrapování je pozastaveno. Scan běží jen z existující cache; po navýšení plánu nebo resetu limitu znovu „Obnovit cache“.',
    };
  }

  const key = jobKey(region, propertyType);
  const existing = jobs.get(key);
  if (existing?.status === 'running') {
    return { queued: false, alreadyRunning: true, job: publicJobView(existing) };
  }

  if (!force) {
    const meta = await getListingCacheMeta(region, propertyType);
    if (meta.count >= 3 && meta.ageMs != null && meta.ageMs < cfg.refreshMs) {
      return { queued: false, reason: 'cache_fresh', cache: meta };
    }
  }

  let runs;
  try {
    runs = await startApifyRuns(region, propertyType);
  } catch (e) {
    if (isApifyQuotaError(e)) {
      noteApifyQuotaHit(Number(process.env.RADAR_APIFY_QUOTA_COOLDOWN_HOURS || 6));
    }
    if (shouldSalvageLastApifyRun(e)) {
      console.warn('[Radar BG] Apify start selhal — last-run salvage:', e.message);
      const pulled = await pullLatestApifyIntoCache({ region, propertyType });
      if (!pulled.ok && /dataset-locked|monthly usage|402|403/i.test(String(pulled.message || ''))) {
        noteApifyQuotaHit(Number(process.env.RADAR_APIFY_QUOTA_COOLDOWN_HOURS || 6));
      }
      const doneJob = {
        region,
        propertyType,
        status: pulled.ok ? 'done' : 'error',
        reason: pulled.ok
          ? `${reason}_last_run`
          : isApifyQuotaError(e)
            ? `${reason}_quota`
            : `${reason}_start_failed`,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        stored: pulled.stored ?? 0,
        total: pulled.total ?? 0,
        warnings: [
          ...(e.warnings || []),
          pulled.message,
          isApifyQuotaError(e)
            ? 'Apify měsíční limit — nové scrapování neběží, bereme poslední dostupný dataset.'
            : null,
        ].filter(Boolean),
        error: pulled.ok ? null : pulled.message,
      };
      jobs.set(key, doneJob);
      if (pulled.ok) invalidateRadarScanMemory(region, propertyType);
      return {
        queued: false,
        reason: pulled.ok ? 'apify_last_run' : 'apify_start_failed',
        code: pulled.code || (isApifyQuotaError(e) ? 'APIFY_QUOTA' : 'APIFY_START_FAILED'),
        job: publicJobView(doneJob),
        pulled,
      };
    }
    throw e;
  }

  const job = {
    region,
    propertyType,
    ...runs,
    status: 'running',
    reason,
    startedAt: Date.now(),
    lastPollAt: null,
    finishedAt: null,
  };
  jobs.set(key, job);
  ensurePollLoop();

  console.log(`[Radar BG] Enrich spuštěn (${reason}): ${region}/${propertyType}`);
  setTimeout(() => pollJob(key), 8_000);

  return { queued: true, job: publicJobView(job) };
}

function publicJobView(job) {
  if (!job) return null;
  return {
    region: job.region,
    propertyType: job.propertyType,
    status: job.status,
    reason: job.reason,
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    stored: job.stored ?? null,
    total: job.total ?? null,
    warnings: job.warnings || [],
    error: job.error || null,
    runMeta: job.runMeta || [],
  };
}

export async function getEnrichStatus(region, propertyType) {
  const key = jobKey(region, propertyType);
  const job = jobs.get(key);
  const cache = await getListingCacheMeta(region, propertyType);
  const cfg = getBackgroundEnrichConfig();

  return {
    cache,
    job: publicJobView(job),
    backgroundEnabled: cfg.enabled,
    refreshHours: cfg.refreshMs / 3600_000,
    apifyQuotaCooldownMs: getApifyQuotaCooldownMs(),
    apifyQuotaBlocked: isApifyQuotaCoolingDown(),
    needsRefresh:
      !isApifyQuotaCoolingDown() &&
      (cache.count < 3 || cache.ageMs == null || cache.ageMs >= cfg.refreshMs),
  };
}

export function getAllEnrichJobs() {
  return [...jobs.values()].map(publicJobView);
}

export async function refreshStaleRegions() {
  const cfg = getBackgroundEnrichConfig();
  if (!cfg.enabled || !process.env.APIFY_TOKEN?.trim()) return [];

  const queued = [];
  for (const region of cfg.regions) {
    if (!REGION_IDS[region]) continue;
    for (const propertyType of cfg.propertyTypes) {
      try {
        const result = await queueBackgroundEnrich(region, propertyType, {
          reason: 'scheduled',
        });
        if (result.queued) queued.push(result.job);
      } catch (e) {
        console.warn(`[Radar BG] Scheduled enrich ${region}/${propertyType}:`, e.message);
      }
    }
  }
  return queued;
}

export function startRadarBackgroundScheduler() {
  const cfg = getBackgroundEnrichConfig();
  if (!cfg.enabled) {
    console.log('   Radar BG enrich: vypnuto (RADAR_BG_ENRICH=0)');
    return;
  }
  if (!process.env.APIFY_TOKEN?.trim()) {
    console.log('   Radar BG enrich: ⚠️ chybí APIFY_TOKEN');
    return;
  }

  console.log(
    `   Radar BG enrich: ✅ ${cfg.regions.join(', ')} / ${cfg.propertyTypes.join(', ')} každých ${cfg.refreshMs / 3600_000}h`,
  );

  setTimeout(() => {
    refreshStaleRegions().catch((e) => console.warn('[Radar BG] startup refresh:', e.message));
  }, 5_000);

  setInterval(() => {
    refreshStaleRegions().catch((e) => console.warn('[Radar BG] scheduled refresh:', e.message));
  }, cfg.refreshMs);
}
