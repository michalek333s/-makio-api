/**
 * Radar v2 — 3fázová Anti-RK validace (testovatelná, bez live scrape).
 *
 * Fáze 1  Metadata & blacklist  — E.164, broker_blacklist, multiplicitní telefon,
 *                                 RK vs. majitel keywords
 * Fáze 2  Geo/parametrický fuzzy match — MatchScore vs. RK reference
 * Fáze 3  pHash Hamming ≤ 8
 *
 * Priorita statusu: DUPLICATE_RK > SUSPECTED_BROKER > NEW_PRIVATE.
 * Nedostatek dat → status null (UI nesmí lhát „čistý soukromník“).
 */

import {
  extractCity,
  extractCzPhones,
  finishNormalizedListing,
  normalizeCzPhone,
  parseLayout,
} from '../lib/radarNormalize.js';
import { findPHashMatch, hashesOf, PHASH_HAMMING_THRESHOLD } from './radarPHash.js';

export const RADAR_STATUS = {
  NEW_PRIVATE: 'NEW_PRIVATE',
  DUPLICATE_RK: 'DUPLICATE_RK',
  SUSPECTED_BROKER: 'SUSPECTED_BROKER',
};

export const MULTIPLICITY_CITY_THRESHOLD = 3;
export const MULTIPLICITY_WINDOW_DAYS = 30;

/**
 * Váhy MatchScore (fáze 2). Součet = 1.0.
 * area  ±5 m²     0.25
 * price ±10 %     0.25
 * layout exact    0.20
 * geo   ≤ 500 m   0.30  (jen když oba mají souřadnice; jinak se přerozdělí)
 */
export const MATCH_WEIGHTS = {
  area: 0.25,
  price: 0.25,
  layout: 0.2,
  geo: 0.3,
};

export const MATCH_THRESHOLDS = {
  areaM2: 5,
  priceRatio: 0.1,
  radiusM: 500,
  duplicateScore: 0.75,
};

/** Hranice slova bez JS \\b — to na české diakritice selhává. */
const LB = '(?<!\\p{L})';
const RB = '(?!\\p{L})';

const RK_KEYWORD_RES = [
  new RegExp(`${LB}provize${RB}`, 'iu'),
  new RegExp(`${LB}zastoupen[íi]${RB}`, 'iu'),
  new RegExp(`${LB}(?<!bez\\s)(?<!mimo\\s)(?<!ne\\s)rk${RB}`, 'iu'),
  new RegExp(`${LB}id\\s*zakázky${RB}`, 'iu'),
  new RegExp(`${LB}kancelář${RB}`, 'iu'),
  new RegExp(`${LB}exkluzivn[ěe]${RB}`, 'iu'),
];

const OWNER_SIGNAL_RES = [
  new RegExp(`${LB}přímý\\s+majitel${RB}`, 'iu'),
  new RegExp(`${LB}primy\\s+majitel${RB}`, 'iu'),
  new RegExp(`${LB}bez\\s+provize${RB}`, 'iu'),
  new RegExp(`${LB}bez\\s+rk${RB}`, 'iu'),
  new RegExp(`${LB}rk\\s+nevolat${RB}`, 'iu'),
  new RegExp(`${LB}nevolat\\s+rk${RB}`, 'iu'),
  new RegExp(`${LB}prod[aá]m\\s+s[aá]m${RB}`, 'iu'),
];

function normText(s) {
  return String(s || '');
}

export function listingBlob(listing) {
  return [listing?.title, listing?.description, listing?.agencyName].filter(Boolean).join(' ');
}

export function findRkKeywords(text) {
  const blob = normText(text);
  return RK_KEYWORD_RES.filter((re) => re.test(blob)).map((re) => re.source);
}

export function findOwnerSignals(text) {
  const blob = normText(text);
  return OWNER_SIGNAL_RES.filter((re) => re.test(blob)).map((re) => re.source);
}

function phonesOf(listing) {
  if (Array.isArray(listing?.phones) && listing.phones.length) {
    return listing.phones.map(normalizeCzPhone).filter(Boolean);
  }
  const direct = normalizeCzPhone(listing?.phoneE164 || listing?.phone);
  if (direct) return [direct];
  return extractCzPhones(listing?.phone, listingBlob(listing));
}

function blacklistSet(blacklist) {
  const set = new Set();
  if (!blacklist) return set;
  const list = blacklist instanceof Set ? [...blacklist] : Array.isArray(blacklist) ? blacklist : [];
  for (const item of list) {
    const p = typeof item === 'string' ? normalizeCzPhone(item) : normalizeCzPhone(item?.phone_e164 || item?.phone);
    if (p) set.add(p);
  }
  return set;
}

/**
 * >3 různé nemovitosti v různých městech za 30 dní → podezření na RK.
 * @param {string} phone
 * @param {Array<{ city?: string, locality?: string, listingId?: string, sourceUrl?: string, scrapedAt?: string, date?: string }>} recent
 */
export function multiplicityIsBroker(phone, recent = [], now = Date.now()) {
  const windowMs = MULTIPLICITY_WINDOW_DAYS * 86_400_000;
  const cities = new Set();
  const properties = new Set();
  for (const row of recent) {
    const t = Date.parse(row.scrapedAt || row.date || row.scraped_at || '') || now;
    if (now - t > windowMs) continue;
    const city = (row.city || extractCity(row.locality) || '').toLowerCase();
    if (city) cities.add(city);
    properties.add(String(row.listingId || row.sourceUrl || row.source_url || `${city}-${t}`));
  }
  return {
    isBroker: cities.size > MULTIPLICITY_CITY_THRESHOLD && properties.size > MULTIPLICITY_CITY_THRESHOLD,
    distinctCities: cities.size,
    distinctProperties: properties.size,
  };
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const a1 = Number(lat1);
  const o1 = Number(lon1);
  const a2 = Number(lat2);
  const o2 = Number(lon2);
  if (![a1, o1, a2, o2].every(Number.isFinite)) return Infinity;
  const R = 6371000;
  const dLat = ((a2 - a1) * Math.PI) / 180;
  const dLon = ((o2 - o1) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a1 * Math.PI) / 180) * Math.cos((a2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function lonOf(l) {
  const v = l?.lon ?? l?.lng ?? l?.longitude;
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

function latOf(l) {
  const v = l?.lat ?? l?.latitude;
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * MatchScore 0–1 proti jedné RK referenci.
 */
export function computeMatchScore(listing, reference) {
  const parts = { area: 0, price: 0, layout: 0, geo: 0, geoAvailable: false };
  const reasons = [];

  const aArea = listing.floorArea != null ? Number(listing.floorArea) : null;
  const bArea = reference.floorArea != null ? Number(reference.floorArea) : null;
  if (aArea && bArea && Number.isFinite(aArea) && Number.isFinite(bArea)) {
    const diff = Math.abs(aArea - bArea);
    if (diff <= MATCH_THRESHOLDS.areaM2) {
      parts.area = 1;
      reasons.push(`plocha ±${diff} m²`);
    }
  }

  const aPrice = listing.price != null ? Number(listing.price) : null;
  const bPrice = reference.price != null ? Number(reference.price) : null;
  if (aPrice && bPrice && aPrice > 0 && bPrice > 0) {
    const ratio = Math.abs(aPrice - bPrice) / Math.max(aPrice, bPrice);
    if (ratio <= MATCH_THRESHOLDS.priceRatio) {
      parts.price = 1;
      reasons.push(`cena ±${Math.round(ratio * 100)} %`);
    }
  }

  const aLay = parseLayout(listing.layout) || listing.layout;
  const bLay = parseLayout(reference.layout) || reference.layout;
  if (aLay && bLay && String(aLay).toLowerCase() === String(bLay).toLowerCase()) {
    parts.layout = 1;
    reasons.push(`dispozice ${aLay}`);
  }

  const latA = latOf(listing);
  const lonA = lonOf(listing);
  const latB = latOf(reference);
  const lonB = lonOf(reference);
  if (latA != null && lonA != null && latB != null && lonB != null) {
    parts.geoAvailable = true;
    const dist = haversineMeters(latA, lonA, latB, lonB);
    if (dist <= MATCH_THRESHOLDS.radiusM) {
      parts.geo = 1;
      reasons.push(`GPS ${Math.round(dist)} m`);
    }
  }

  let wArea = MATCH_WEIGHTS.area;
  let wPrice = MATCH_WEIGHTS.price;
  let wLayout = MATCH_WEIGHTS.layout;
  let wGeo = MATCH_WEIGHTS.geo;
  if (!parts.geoAvailable) {
    const rest = 1 - MATCH_WEIGHTS.geo;
    wArea = MATCH_WEIGHTS.area / rest;
    wPrice = MATCH_WEIGHTS.price / rest;
    wLayout = MATCH_WEIGHTS.layout / rest;
    wGeo = 0;
  }

  const score = parts.area * wArea + parts.price * wPrice + parts.layout * wLayout + parts.geo * wGeo;
  return {
    score,
    parts,
    reasons,
    listingId: reference.listingId || reference.id || null,
    url: reference.url || reference.sourceUrl || null,
    agencyName: reference.agencyName || reference.agency_name || null,
  };
}

export function findBestParametricMatch(listing, referenceListings = []) {
  let best = null;
  for (const ref of referenceListings) {
    if (!ref) continue;
    const m = computeMatchScore(listing, ref);
    if (!best || m.score > best.score) best = m;
  }
  return best;
}

function recentForPhone(phone, recentByPhone) {
  if (!phone || !recentByPhone) return [];
  if (recentByPhone instanceof Map) return recentByPhone.get(phone) || [];
  return recentByPhone[phone] || [];
}

/**
 * @param {object} listing
 * @param {{ blacklist?: Array|Set, referenceListings?: object[], recentByPhone?: object|Map }} ctx
 * @returns {{ status: string|null, matchConfidence: number, matchedAgencyListingId: string|null, matchedAgencyUrl: string|null, reasons: string[], stages: object, autoBlacklist?: { phone: string, reason: string } }}
 */
export function validateRadarListing(listing, ctx = {}) {
  const reasons = [];
  const stages = { metadata: null, geo: null, phash: null };
  const phones = phonesOf(listing);
  const blob = listingBlob(listing);
  const rkHits = findRkKeywords(blob);
  const ownerHits = findOwnerSignals(blob);
  const bl = blacklistSet(ctx.blacklist);

  const blacklisted = phones.find((p) => bl.has(p)) || null;
  let autoBlacklist = null;
  let multiplicityHit = false;

  for (const phone of phones) {
    const multi = multiplicityIsBroker(phone, recentForPhone(phone, ctx.recentByPhone));
    if (multi.isBroker) {
      multiplicityHit = true;
      reasons.push(
        `Telefon ${phone}: ${multi.distinctProperties} inzerátů v ${multi.distinctCities} městech / ${MULTIPLICITY_WINDOW_DAYS} dní`,
      );
      autoBlacklist = {
        phone,
        reason: `multiplicitní inzerce (${multi.distinctCities} měst)`,
      };
      break;
    }
  }

  if (blacklisted) {
    reasons.push(`Telefon ${blacklisted} je na broker_blacklist`);
  }
  if (rkHits.length) {
    reasons.push(`RK keywords: ${rkHits.length}`);
  }
  if (ownerHits.length) {
    reasons.push(`Signál majitele: ${ownerHits.length}`);
  }

  const suspectedFromMeta =
    Boolean(blacklisted) || multiplicityHit || (rkHits.length > 0 && ownerHits.length === 0);

  stages.metadata = {
    phones,
    blacklisted: Boolean(blacklisted),
    multiplicityHit,
    rkKeywords: rkHits.length,
    ownerSignals: ownerHits.length,
    suspected: suspectedFromMeta,
  };

  const refs = Array.isArray(ctx.referenceListings) ? ctx.referenceListings : [];
  const geo = refs.length ? findBestParametricMatch(listing, refs) : null;
  stages.geo = geo
    ? { score: geo.score, reasons: geo.reasons, listingId: geo.listingId, url: geo.url }
    : { score: 0, skipped: refs.length === 0 };

  const listingHashes = hashesOf(listing);
  const phash = findPHashMatch(listing, refs, PHASH_HAMMING_THRESHOLD);
  stages.phash = phash
    ? { distance: phash.distance, listingId: phash.listingId, url: phash.url }
    : { distance: null, skipped: listingHashes.length === 0 };

  let status = null;
  let matchConfidence = 0;
  let matchedAgencyListingId = null;
  let matchedAgencyUrl = null;
  let matchedAgencyName = null;

  if (phash) {
    status = RADAR_STATUS.DUPLICATE_RK;
    matchConfidence = Math.max(0.85, 1 - phash.distance / 64);
    matchedAgencyListingId = phash.listingId;
    matchedAgencyUrl = phash.url;
    matchedAgencyName = phash.agencyName || null;
    reasons.unshift(`pHash Hamming ${phash.distance} ≤ ${PHASH_HAMMING_THRESHOLD}`);
  } else if (geo && geo.score >= MATCH_THRESHOLDS.duplicateScore) {
    status = RADAR_STATUS.DUPLICATE_RK;
    matchConfidence = geo.score;
    matchedAgencyListingId = geo.listingId;
    matchedAgencyUrl = geo.url;
    matchedAgencyName = geo.agencyName || null;
    reasons.unshift(`Geo/parametrická shoda ${(geo.score * 100).toFixed(0)} %`);
  } else if (suspectedFromMeta) {
    status = RADAR_STATUS.SUSPECTED_BROKER;
    matchConfidence = blacklisted || multiplicityHit ? 0.9 : Math.min(0.7, 0.35 + rkHits.length * 0.1);
  } else if (ownerHits.length > 0 || phones.length > 0 || blob.trim().length > 0 || listing.source) {
    const hasSignal =
      ownerHits.length > 0 ||
      listing.radarStream === 'private' ||
      ['bazos', 'bezrealitky', 'facebook', 'facebook_marketplace', 'sbazar'].includes(
        String(listing.source || '').toLowerCase(),
      );
    if (hasSignal) {
      status = RADAR_STATUS.NEW_PRIVATE;
      matchConfidence = ownerHits.length > 0 ? 0.7 : 0.45;
      if (geo?.score) {
        reasons.push(`Nejlepší RK match jen ${(geo.score * 100).toFixed(0)} % (pod prahem)`);
      }
      if (!ownerHits.length) {
        reasons.push('Žádný RK signál v metadatech — kandidát na soukromníka (ne záruka)');
      }
    }
  }

  return {
    status,
    matchConfidence,
    matchedAgencyListingId,
    matchedAgencyUrl,
    matchedAgencyName,
    reasons,
    stages,
    autoBlacklist,
  };
}

export function radarValidationStats(listings = []) {
  const counts = { NEW_PRIVATE: 0, DUPLICATE_RK: 0, SUSPECTED_BROKER: 0, unknown: 0 };
  for (const l of listings) {
    const s = l?.radarStatus;
    if (s && counts[s] != null) counts[s] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

export function buildRecentByPhone(listings = []) {
  const map = new Map();
  for (const l of listings) {
    const phones = phonesOf(l);
    for (const phone of phones) {
      if (!map.has(phone)) map.set(phone, []);
      map.get(phone).push({
        listingId: l.listingId,
        city: l.city || extractCity(l.locality),
        locality: l.locality,
        sourceUrl: l.url || l.sourceUrl,
        scrapedAt: l.scrapedAt,
      });
    }
  }
  return map;
}

/**
 * Připojí radarStatus na inzeráty. Sreality RK = reference, bez badge.
 * Bez dostatku signálů nechá status null.
 */
export function attachRadarValidation(listings, { blacklist, extraReferences = [] } = {}) {
  if (!Array.isArray(listings) || listings.length === 0) return listings;
  const normalized = listings.map((l) => finishNormalizedListing(l));
  const fromBatch = normalized.filter((l) => {
    const src = String(l.source || '').toLowerCase();
    return src === 'sreality' || src === 'idnes' || src === 'idnes_reality' || l.isAgencyListing === true;
  });
  const extra = (Array.isArray(extraReferences) ? extraReferences : []).map((l) =>
    finishNormalizedListing(l),
  );
  const referenceListings = [...fromBatch, ...extra];
  const recentByPhone = buildRecentByPhone([...normalized, ...extra]);

  return normalized.map((listing) => {
    const src = String(listing.source || '').toLowerCase();
    const isReferenceAgency =
      (src === 'sreality' || src === 'idnes' || src === 'idnes_reality') &&
      listing.isAgencyListing &&
      !listing.fsboSignal;
    if (isReferenceAgency) {
      return listing;
    }

    const result = validateRadarListing(listing, {
      blacklist,
      referenceListings,
      recentByPhone,
    });

    if (!result.status) return listing;

    return {
      ...listing,
      radarStatus: result.status,
      radarMatchConfidence: result.matchConfidence,
      matchedAgencyListingId: result.matchedAgencyListingId,
      matchedAgencyUrl: result.matchedAgencyUrl,
      matchedAgencyName: result.matchedAgencyName,
      radarReasons: result.reasons,
    };
  });
}
