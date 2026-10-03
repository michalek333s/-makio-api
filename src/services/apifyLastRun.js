/**
 * Stažení dat z posledních úspěšných Apify běhů — bez spuštění nového (limit 403).
 * Poctivě filtruje podle kraje: ok jen když se něco opravdu uložilo.
 */

import { getDatasetItems, getRunStatus } from './apify.js';
import { normalizeSrealityApifyListing } from './srealityApify.js';
import { storeRadarListings } from './radarCacheStore.js';
import { filterListingsByRegion } from '../lib/radarRegions.js';
import { finishNormalizedListing } from '../lib/radarNormalize.js';
import { invalidateRadarScanMemory } from './radarScanMemory.js';

const APIFY_BASE = 'https://api.apify.com/v2';

function token() {
  const t = process.env.APIFY_TOKEN?.trim();
  if (!t) throw new Error('APIFY_TOKEN není nastaven');
  return t;
}

async function getLastSucceededRuns(actorId, limit = 5) {
  const tok = token();
  const actorPath = encodeURIComponent(actorId);
  const url =
    `${APIFY_BASE}/acts/${actorPath}/runs` +
    `?token=${encodeURIComponent(tok)}&status=SUCCEEDED&desc=true&limit=${Math.min(10, Math.max(1, limit))}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Apify runs list ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data?.data?.items) ? data.data.items : [];
}

/**
 * Načte poslední úspěšný Sreality Apify dataset do RAM/disk cache (pro daný kraj).
 */
export async function pullLatestApifyIntoCache({ region, propertyType }) {
  const actor =
    process.env.RADAR_SREALITY_ACTOR?.trim() ||
    'logiover~sreality-cz-scraper-czech-real-estate-data';

  let runs = [];
  try {
    runs = await getLastSucceededRuns(actor, 5);
  } catch (e) {
    return { ok: false, message: e.message || 'Apify runs list selhal.', code: 'APIFY_RUNS_LIST' };
  }

  if (!runs.length) {
    return { ok: false, message: 'Žádný hotový Apify běh k dispozici.', code: 'NO_SUCCEEDED_RUN' };
  }

  let lastTotal = 0;
  let lastRunId = null;
  const tried = [];

  for (const run of runs) {
    if (!run?.id) continue;
    lastRunId = run.id;
    try {
      const status = await getRunStatus(run.id);
      if (status.status !== 'SUCCEEDED' || !status.datasetId) {
        tried.push({ runId: run.id, skip: status.status });
        continue;
      }

      const items = await getDatasetItems(status.datasetId);
      if (!items?.length) {
        tried.push({ runId: run.id, skip: 'empty_dataset' });
        continue;
      }

      const listings = items
        .map((item) => finishNormalizedListing(normalizeSrealityApifyListing(item)))
        .filter(Boolean)
        .map((l) => ({ ...l, region: l.region || region }));

      lastTotal = listings.length;
      const inRegion = filterListingsByRegion(listings, region);
      if (!inRegion.length) {
        tried.push({ runId: run.id, total: listings.length, inRegion: 0 });
        continue;
      }

      const stored = await storeRadarListings(inRegion, { region, propertyType });
      if (stored > 0) {
        invalidateRadarScanMemory(region, propertyType);
        return {
          ok: true,
          stored,
          total: listings.length,
          inRegion: inRegion.length,
          runId: run.id,
          code: 'LAST_RUN_OK',
          message: `Načteno ${stored} inzerátů pro ${region} z Apify běhu (${run.id.slice(0, 8)}…).`,
        };
      }
      tried.push({ runId: run.id, total: listings.length, inRegion: inRegion.length, stored: 0 });
    } catch (e) {
      tried.push({ runId: run.id, error: e.message });
      // dataset-locked na čtení — zkus další běh
      if (/dataset-locked|monthly usage|403|402/i.test(String(e.message || ''))) {
        continue;
      }
    }
  }

  return {
    ok: false,
    stored: 0,
    total: lastTotal,
    runId: lastRunId,
    tried,
    code: 'LAST_RUN_REGION_MISS',
    message:
      lastTotal > 0
        ? `Poslední Apify běhy nemají inzeráty pro kraj ${region} (cache beze změny).`
        : 'Poslední Apify běhy nešly použít (limit nebo prázdný dataset).',
  };
}

export function isApifyQuotaError(err) {
  const msg = String(err?.message || err || '');
  const warnings = Array.isArray(err?.warnings) ? err.warnings.join(' ') : '';
  const blob = `${msg} ${warnings}`;
  return (
    err?.status === 403 ||
    err?.code === 'APIFY_QUOTA' ||
    /monthly usage hard limit|platform-feature-disabled|quota|dataset-locked|403|Nepodařilo se spustit žádný Apify/i.test(
      blob,
    )
  );
}

/** Agregované chyby startu běhů — vždy zkusit last-run salvage. */
export function shouldSalvageLastApifyRun(err) {
  if (!err) return true;
  return (
    isApifyQuotaError(err) ||
    /Nepodařilo se spustit|Apify|403|429|502|503|fetch failed|network/i.test(
      String(err.message || ''),
    )
  );
}
