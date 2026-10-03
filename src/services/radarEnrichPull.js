/**
 * Sdílená logika stažení hotových Apify běhů do radar cache.
 */

import { getRunStatus, getDatasetItems, normalizeListing } from './apify.js';
import { normalizeBazosListing } from './bazos.js';
import { normalizeFacebookListing, unwrapFacebookDatasetItems } from './facebookMarketplace.js';
import { normalizeSrealityApifyListing } from './srealityApify.js';
import { storeRadarListings } from './radarCacheStore.js';
import { deduplicateListings } from './deduplicator.js';
import { verifyAgencySignalsViaSrealityDetail } from './radarAgencyVerify.js';
import { ingestRadarBatch, getMemoryBlacklist } from './radarIngest.js';
import { persistRadarV2Ingest, loadAgencyReferencesForMatch } from './radarV2Store.js';
import { collectNearbyAgencyReferences, isPostgisMatchEnabled } from './radarPostgisMatch.js';
import { calculatePhashes } from './radarPHash.js';

export async function pullEnrichRuns({
  srealityRunId,
  czRealityRunId,
  bazosRunId,
  facebookRunId,
  region,
  propertyType,
}) {
  const listings = [];
  const runMeta = [];
  let pending = false;
  const warnings = [];

  const jobs = [
    { kind: 'sreality', runId: srealityRunId, normalize: normalizeSrealityApifyListing },
    {
      kind: 'bezrealitky',
      runId: czRealityRunId,
      normalize: (item) =>
        normalizeListing({ ...item, source: item.source || item.portal || 'bezrealitky' }),
    },
    { kind: 'bazos', runId: bazosRunId, normalize: normalizeBazosListing },
    { kind: 'facebook', runId: facebookRunId, normalize: normalizeFacebookListing },
  ];

  for (const { kind, runId, normalize } of jobs) {
    if (!runId) continue;
    const status = await getRunStatus(runId);
    runMeta.push({ kind, runId, status: status.status, itemCount: status.itemCount });

    if (status.status === 'RUNNING' || status.status === 'READY') {
      pending = true;
      continue;
    }
    if (status.status !== 'SUCCEEDED') {
      warnings.push(`Běh ${kind} selhal (${status.status}).`);
      continue;
    }

    const items = await getDatasetItems(status.datasetId);
    for (const item of items) {
      const rows = kind === 'facebook' ? unwrapFacebookDatasetItems(item) : [item];
      for (const row of rows) {
        const listing = normalize(row);
        if (listing) listings.push(listing);
      }
    }
  }

  if (pending) {
    return { ok: false, pending: true, listings, runMeta, warnings };
  }

  if (!listings.length) {
    // Apify doběhl, ale dataset je prázdný (filtr regionu / actor) — není fatální selhání.
    const softMsg = warnings.length
      ? warnings.join(' ')
      : 'Apify doběhl bez inzerátů pro daný filtr — ponechávám stávající cache.';
    return {
      ok: true,
      empty: true,
      pending: false,
      listings: [],
      stored: 0,
      total: 0,
      runMeta,
      warnings: warnings.length ? warnings : [softMsg],
      message: softMsg,
    };
  }

  const deduped = deduplicateListings(listings);
  let toStore = deduped;

  if (process.env.RADAR_DETAIL_VERIFY !== '0') {
    const enrichMax = Number(process.env.RADAR_DETAIL_VERIFY_ON_ENRICH_MAX || 40);
    const verified = await verifyAgencySignalsViaSrealityDetail(deduped, {
      maxLookups: enrichMax,
    });
    toStore = verified.listings;
  }

  const extraReferences = [];
  try {
    extraReferences.push(...(await loadAgencyReferencesForMatch({ region })));
  } catch (e) {
    console.warn('[Radar v2] enrich load references:', e.message);
  }
  if (isPostgisMatchEnabled()) {
    try {
      extraReferences.push(...(await collectNearbyAgencyReferences(toStore)));
    } catch (e) {
      console.warn('[Radar v2] enrich PostGIS:', e.message);
    }
  }

  let hashed = toStore;
  if (process.env.RADAR_HASH_IMAGES === '1') {
    hashed = [];
    let used = 0;
    for (const listing of toStore) {
      if (used >= 8 || listing?.photoPHash || (listing?.imageHashes || []).length) {
        hashed.push(listing);
        continue;
      }
      const urls = listing.imageUrls || listing.image_urls || [];
      if (!urls.length) {
        hashed.push(listing);
        continue;
      }
      used += 1;
      const hashes = await calculatePhashes(urls, { max: 3 });
      hashed.push(hashes.length ? { ...listing, photoPHash: hashes[0], imageHashes: hashes } : listing);
    }
  }

  const ingested = ingestRadarBatch(hashed, {
    referenceListings: extraReferences,
    blacklist: getMemoryBlacklist(),
  });
  const withStatus = ingested.map((row) => row.listing);
  const stored = await storeRadarListings(withStatus, { region, propertyType });
  let v2 = null;
  try {
    v2 = await persistRadarV2Ingest(ingested, { region });
  } catch (e) {
    console.warn('[Radar v2] persist enrich:', e.message);
  }

  let watchdog = null;
  try {
    const { ingestRadarWebhookItems } = await import('./radarWatchdogIngest.js');
    watchdog = await ingestRadarWebhookItems(withStatus, { region, propertyType });
  } catch (e) {
    console.warn('[Radar Watchdog] enrich ingest:', e.message);
  }
  return {
    ok: true,
    pending: false,
    stored,
    total: withStatus.length,
    listings: withStatus,
    runMeta,
    warnings,
    radarV2: v2,
    watchdog,
    radarStatusCounts: withStatus.reduce((acc, l) => {
      const s = l.radarStatus || 'unknown';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {}),
  };
}
