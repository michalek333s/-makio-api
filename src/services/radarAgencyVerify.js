/**
 * Ověření RK vs. FSBO přes Sreality detail API (zdarma, bez Apify).
 * U pochybných inzerátů (Bazoš/FB/Bezrealitky nebo Sreality bez rus) dotáhne detail
 * a přepočítá agency signály z polí company/broker/premise.
 */

import { fetchSrealityEstateDetail } from './sreality.js';
import { applyAgencySignals } from './listingAgency.js';

const DOUBT_SOURCES = new Set(['bazos', 'bezrealitky', 'facebook', 'facebook_marketplace']);

/** @type {Map<string, object|null>} */
const detailCache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string|null|undefined} url */
export function extractSrealityHashFromUrl(url) {
  if (!url || !String(url).includes('sreality.cz')) return null;
  const m = String(url).match(/\/(\d{6,})(?:[/?#]|$)/);
  return m?.[1] || null;
}

/** @param {object} listing */
export function extractSrealityHashId(listing) {
  if (!listing || typeof listing !== 'object') return null;

  if (String(listing.source || '').toLowerCase() === 'sreality') {
    const id = String(listing.listingId || '').trim();
    if (/^\d{6,}$/.test(id)) return id;
  }

  const fromUrl = extractSrealityHashFromUrl(listing.url);
  if (fromUrl) return fromUrl;

  if (Array.isArray(listing.duplicateUrls)) {
    for (const u of listing.duplicateUrls) {
      const h = extractSrealityHashFromUrl(u);
      if (h) return h;
    }
  }

  const id = String(listing.listingId || '').trim();
  if (/^\d{6,}$/.test(id)) return id;

  return null;
}

/** @param {object} listing */
export function listingNeedsAgencyVerify(listing) {
  if (!listing || listing.agencyVerified) return false;
  if (listing.isAgencyListing) return false;

  const hash = extractSrealityHashId(listing);
  if (!hash) return false;

  const src = String(listing.source || '').toLowerCase();

  if (src === 'sreality') {
    if (listing.fsboSignal && listing.rus === true) return false;
    return listing.sellerType !== 'agency';
  }

  if (DOUBT_SOURCES.has(src)) return true;

  if (listing.multiPortalBonus && hash) return true;

  return false;
}

function agencyFieldsFromDetail(rawEstate) {
  const companyName =
    (typeof rawEstate.company?.name === 'string' && rawEstate.company.name) ||
    (typeof rawEstate.company?.name?.value === 'string' && rawEstate.company.name.value) ||
    null;
  const brokerName =
    (typeof rawEstate.broker?.name === 'string' && rawEstate.broker.name) ||
    (typeof rawEstate.broker?.name?.value === 'string' && rawEstate.broker.name.value) ||
    null;
  const publishedAt = rawEstate.seo?.published || rawEstate.published || null;
  const daysOnPortal =
    publishedAt && Number.isFinite(Date.parse(publishedAt))
      ? Math.max(0, Math.floor((Date.now() - Date.parse(publishedAt)) / 86_400_000))
      : null;
  const rus = rawEstate.rus === true;
  const hasPremise = Boolean(rawEstate.premise?.id || rawEstate.premise_id);

  return {
    agencyName: companyName || brokerName,
    brokerName,
    sellerType: rus ? 'private' : companyName || brokerName || hasPremise ? 'agency' : 'unknown',
    rus,
    publishedAt,
    daysOnPortal,
    daysTracked: daysOnPortal,
    hasVirtualTour: Boolean(rawEstate.has_matterport_url || rawEstate.matterport_url),
    _raw: rawEstate,
  };
}

/** @param {object} listing @param {object} rawEstate */
function mergeVerifiedAgency(listing, rawEstate) {
  const detail = agencyFieldsFromDetail(rawEstate);
  return applyAgencySignals({
    ...listing,
    ...detail,
    agencyVerified: true,
    agencyVerifySource: 'sreality_detail',
  });
}

async function fetchDetailCached(hashId) {
  if (detailCache.has(hashId)) return detailCache.get(hashId);

  try {
    const raw = await fetchSrealityEstateDetail(hashId);
    detailCache.set(hashId, raw || null);
    return raw || null;
  } catch (e) {
    console.warn(`[Radar verify] detail ${hashId}:`, e.message);
    detailCache.set(hashId, null);
    return null;
  }
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * @param {Array<object>} listings
 * @param {{ maxLookups?: number, concurrency?: number, delayMs?: number }} [opts]
 */
export async function verifyAgencySignalsViaSrealityDetail(listings, opts = {}) {
  const maxLookups = Number(opts.maxLookups ?? process.env.RADAR_DETAIL_VERIFY_MAX ?? 20);
  const concurrency = Number(opts.concurrency ?? process.env.RADAR_DETAIL_VERIFY_CONCURRENCY ?? 4);
  const delayMs = Number(opts.delayMs ?? 120);

  if (process.env.RADAR_DETAIL_VERIFY === '0') {
    return { listings, stats: { skipped: true, reason: 'disabled' } };
  }

  const candidates = [];
  const hashByIndex = new Map();

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    if (!listingNeedsAgencyVerify(listing)) continue;
    const hash = extractSrealityHashId(listing);
    if (!hash || hashByIndex.has(hash)) continue;
    hashByIndex.set(hash, i);
    candidates.push({ index: i, hash, listing });
    if (candidates.length >= maxLookups) break;
  }

  if (!candidates.length) {
    return { listings, stats: { checked: 0, upgraded: 0, confirmedFsbo: 0, failed: 0 } };
  }

  console.log(`[Radar verify] Kontrola RK přes Sreality detail: ${candidates.length} inzerátů`);

  let upgraded = 0;
  let confirmedFsbo = 0;
  let failed = 0;

  const updated = [...listings];

  await mapWithConcurrency(candidates, concurrency, async ({ index, hash, listing }) => {
    if (delayMs > 0) await sleep(delayMs);
    const raw = await fetchDetailCached(hash);
    if (!raw) {
      failed++;
      return;
    }

    const before = listing.isAgencyListing;
    const merged = mergeVerifiedAgency(listing, raw);
    updated[index] = merged;

    if (merged.isAgencyListing && !before) upgraded++;
    else if (!merged.isAgencyListing) confirmedFsbo++;
  });

  const stats = {
    checked: candidates.length,
    upgraded,
    confirmedFsbo,
    failed,
  };
  console.log(`[Radar verify] Hotovo: ${upgraded} RK odhaleno, ${confirmedFsbo} FSBO potvrzeno`);

  return { listings: updated, stats };
}

/** Vyprázdnit cache detailů (testy / dlouhý běh). */
export function clearAgencyVerifyCache() {
  detailCache.clear();
}
