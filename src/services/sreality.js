import { applyAgencySignals } from './listingAgency.js';
import { finishNormalizedListing } from '../lib/radarNormalize.js';

const SREALITY_API = 'https://www.sreality.cz/api/cs/v2/estates';

/** Po 404/403 z datacenter IP vypnout přímé API na několik hodin (Apify zůstává). */
let directBlockedUntil = 0;
const DIRECT_BLOCK_MS = 6 * 60 * 60 * 1000;

export function isSrealityDirectBlocked() {
  if (process.env.RADAR_SREALITY_DIRECT === '0') return true;
  return Date.now() < directBlockedUntil;
}

/** Sreality locality_region_id — shodné s Apify actorem logiover (README). */
export const REGION_IDS = {
  Jihomoravský: 1,
  Karlovarský: 2,
  Královéhradecký: 3,
  Liberecký: 4,
  Plzeňský: 5,
  Pardubický: 6,
  Moravskoslezský: 7,
  // 8 rezervováno / nepoužíváme
  Ústecký: 9,
  Praha: 10,
  Středočeský: 11,
  Olomoucký: 12,
  Jihočeský: 13,
  Vysočina: 14,
  Zlínský: 15,
};

const CATEGORY_MAIN = { byty: 1, domy: 2, pozemky: 3 };
const OFFER_TYPE = { prodej: 1, pronajem: 2 };

function parsePriceNumber(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

const SREALITY_FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'cs',
  Referer: 'https://www.sreality.cz/',
  Origin: 'https://www.sreality.cz',
};

/**
 * Všechny URL fotek z HAL `_links.images` (seznam i detail).
 */
export function extractSrealityImageUrls(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  const imgs = raw._links?.images;
  if (Array.isArray(imgs)) {
    for (const item of imgs) {
      const h = item?.href;
      if (typeof h === 'string' && /^https?:\/\//i.test(h)) out.push(h);
    }
  }
  const single = raw._links?.image?.href;
  if (typeof single === 'string' && /^https?:\/\//i.test(single) && !out.includes(single)) {
    out.push(single);
  }
  return [...new Set(out)].slice(0, 40);
}

/**
 * Detail inzerátu — často více fotek než v přehledovém výpisu.
 * @param {string|number} hashId — hash_id z API
 */
export async function fetchSrealityEstateDetail(hashId) {
  if (hashId == null || String(hashId).trim() === '') return null;
  const url = `${SREALITY_API}/${encodeURIComponent(String(hashId))}?tms=${Date.now()}`;
  const res = await fetch(url, {
    headers: SREALITY_FETCH_HEADERS,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data?.hash_id != null && data?._links) return data;
  return data?._embedded?.estates?.[0] ?? data?.estate ?? null;
}

/**
 * @param {string|number} hashId — hash_id z API
 */
export async function fetchSrealityGalleryUrlsByHash(hashId) {
  const estate = await fetchSrealityEstateDetail(hashId);
  if (!estate || typeof estate !== 'object') return [];
  return extractSrealityImageUrls(estate);
}

/**
 * @param {object} opts
 */
export async function fetchSrealityDirect({
  region = 'Moravskoslezský',
  propertyType = 'byty',
  offerType = 'prodej',
  maxPrice = null,
  minArea = null,
  perPage = 60,
}) {
  if (isSrealityDirectBlocked()) {
    const err = new Error(
      'Sreality přímé API je vypnuté (404 blokace / RADAR_SREALITY_DIRECT). Použijte Apify cache.',
    );
    err.statusCode = 404;
    err.code = 'SREALITY_DIRECT_DISABLED';
    throw err;
  }

  const regionId = REGION_IDS[region];
  if (!regionId) {
    throw new Error(`Neznámý region: ${region}`);
  }

  const pp = Math.min(100, Math.max(1, Math.floor(Number(perPage)) || 60));

  const params = new URLSearchParams({
    category_main_cb: String(CATEGORY_MAIN[propertyType] || 1),
    category_type_cb: String(OFFER_TYPE[offerType] || 1),
    locality_region_id: String(regionId),
    per_page: String(pp),
    page: '1',
    tms: String(Date.now()),
  });

  if (maxPrice != null && Number.isFinite(Number(maxPrice)) && Number(maxPrice) > 0) {
    params.set('czk_price_summary_order2', `0|${Math.floor(Number(maxPrice))}`);
  }
  if (minArea != null && Number.isFinite(Number(minArea)) && Number(minArea) > 0) {
    params.set('usable_area', `${Math.floor(Number(minArea))}|`);
  }

  const url = `${SREALITY_API}?${params}`;
  console.log(`[Sreality] ${url}`);

  const res = await fetch(url, {
    headers: SREALITY_FETCH_HEADERS,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    if (res.status === 404 || res.status === 403) {
      directBlockedUntil = Date.now() + DIRECT_BLOCK_MS;
      console.warn(
        `[Sreality] HTTP ${res.status} — přímé API vypnuto na ${Math.round(DIRECT_BLOCK_MS / 3600000)} h (datacenter blokace).`,
      );
    }
    const err = new Error(
      res.status === 404
        ? 'Sreality API chyba: 404 (blokace z tohoto serveru, ne „nenalezeno“ v Makiu)'
        : `Sreality API chyba: ${res.status}`,
    );
    err.statusCode = res.status;
    throw err;
  }

  const data = await res.json();
  const estates = data?._embedded?.estates || [];

  if (estates.length > 0) {
    console.log('[Sreality] Ukázka prvního záznamu (klíče):', Object.keys(estates[0]));
  } else {
    console.warn('[Sreality] Žádné výsledky — zkontrolujte region a parametry.');
  }

  return {
    listings: estates.map(normalizeSrealityEstate),
    totalCount: data?.result_size ?? estates.length,
    source: 'sreality_direct',
  };
}

/**
 * Vnořené objekty API: name.locality.price_czk; „dohodou“ často jako 1 Kč → price null.
 */
export function normalizeSrealityEstate(raw) {
  const title =
    (typeof raw.name === 'object' && raw.name?.value) || (typeof raw.name === 'string' ? raw.name : '') || '';
  const locality =
    (typeof raw.locality === 'object' && raw.locality?.value) ||
    (typeof raw.locality === 'string' ? raw.locality : '') ||
    '';

  let priceNum = parsePriceNumber(raw.price_czk?.value_raw);
  if (priceNum == null) {
    priceNum = parsePriceNumber(raw.price_czk?.value);
  }
  if (priceNum == null) {
    priceNum = parsePriceNumber(raw.price);
  }

  const price = priceNum != null && priceNum > 1000 ? priceNum : null;

  const layoutMatch = String(title).match(/(\d+\+(?:kk|\d))/i);
  const areaMatch = String(title).match(/(\d{2,4})\s*m[²2]/i);

  const gps = raw.gps || {};

  const floorArea = areaMatch ? parseInt(areaMatch[1], 10) : null;
  const pricePerSqm =
    price && floorArea && floorArea > 0 ? Math.round(price / floorArea) : null;

  const hashId = raw.hash_id;
  let url = raw.url || null;
  if (!url && hashId != null) {
    const catSlug = { 1: 'byt', 2: 'dum', 3: 'pozemek' }[raw.seo?.category_main_cb] || 'nemovitost';
    const offerSlug = { 1: 'prodej', 2: 'pronajem' }[raw.seo?.category_type_cb] || 'prodej';
    const localitySlug =
      typeof raw.seo?.locality === 'string' && raw.seo.locality.trim()
        ? raw.seo.locality.trim()
        : null;
    const layoutSlug = layoutMatch?.[1]?.toLowerCase() || null;

    if (catSlug === 'byt' && localitySlug) {
      // Sreality detail u bytů očekává i dispoziční segment; i nepřesná hodnota se obvykle přesměruje.
      url = `https://www.sreality.cz/detail/${offerSlug}/${catSlug}/${layoutSlug || '1+1'}/${localitySlug}/${hashId}`;
    } else if (localitySlug) {
      url = `https://www.sreality.cz/detail/${offerSlug}/${catSlug}/${localitySlug}/${hashId}`;
    } else {
      url = `https://www.sreality.cz/detail/${offerSlug}/${catSlug}/${hashId}`;
    }
  }

  let imageUrls = extractSrealityImageUrls(raw);
  if (!imageUrls.length && typeof raw.photo === 'string' && /^https?:\/\//i.test(raw.photo)) {
    imageUrls = [raw.photo];
  }
  const imageUrl = imageUrls[0] || null;

  const companyName =
    (typeof raw.company?.name === 'string' && raw.company.name) ||
    (typeof raw.company?.name?.value === 'string' && raw.company.name.value) ||
    null;
  const brokerName =
    (typeof raw.broker?.name === 'string' && raw.broker.name) ||
    (typeof raw.broker?.name?.value === 'string' && raw.broker.name.value) ||
    null;
  const publishedAt = raw.seo?.published || raw.published || null;
  const daysOnPortal = publishedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(publishedAt)) / 86_400_000))
    : null;

  const base = {
    listingId: String(hashId ?? Math.random().toString(36).slice(2)),
    source: 'sreality',
    title: title || 'Bez názvu',
    price,
    pricePerSqm,
    locality: locality || 'Neznámá lokalita',
    layout: layoutMatch?.[1] || null,
    floorArea,
    landArea: null,
    lat: gps.lat ?? null,
    lon: gps.lon ?? null,
    imageUrl,
    imageUrls,
    url,
    isNew: daysOnPortal != null && daysOnPortal <= 3,
    priceChanged: false,
    previousPrice: null,
    daysTracked: daysOnPortal,
    daysOnPortal,
    publishedAt,
    priceToMedianRatio: null,
    agencyName: companyName || brokerName,
    brokerName,
    sellerType: raw.rus === true ? 'private' : companyName || brokerName ? 'agency' : 'unknown',
    rus: raw.rus === true,
    hasVirtualTour: Boolean(raw.has_matterport_url || raw.matterport_url),
    hasProPhotos: imageUrls.length >= 8,
    scrapedAt: new Date().toISOString(),
    _raw: raw,
  };

  return finishNormalizedListing(applyAgencySignals(base));
}
