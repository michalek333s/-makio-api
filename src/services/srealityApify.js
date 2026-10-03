/**
 * Sreality přes Apify (residential proxy) — náhrada za přímé JSON API,
 * které z datacenter IP často vrací 404.
 */

import { applyAgencySignals } from './listingAgency.js';
import { finishNormalizedListing } from '../lib/radarNormalize.js';
import { REGION_IDS } from './sreality.js';

const SREALITY_ACTOR =
  process.env.RADAR_SREALITY_ACTOR?.trim() || 'logiover~sreality-cz-scraper-czech-real-estate-data';
const APIFY_BASE = 'https://api.apify.com/v2';

const CATEGORY_MAP = { byty: 'apartment', domy: 'house', pozemky: 'land' };
const OFFER_MAP = { prodej: 'sale', pronajem: 'rent' };

function apifyToken() {
  const t = process.env.APIFY_TOKEN?.trim();
  if (!t) {
    const err = new Error('APIFY_TOKEN není nastaven v nemio-backend/.env');
    err.status = 503;
    throw err;
  }
  return t;
}

function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1000 ? raw : null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 1000 ? n : null;
}

/** Spustí Apify actor pro Sreality, vrátí runId. */
export async function startSrealityApifyScrape({
  region,
  propertyType = 'byty',
  offerType = 'prodej',
  maxListings = 200,
  maxPrice = null,
  minArea = null,
}) {
  const regionId = REGION_IDS[region];
  if (!regionId) {
    throw new Error(`Neznámý region pro Sreality Apify: ${region}`);
  }

  const token = apifyToken();
  const deltaPages = Number(process.env.RADAR_DELTA_MAX_PAGES || 3);
  const deltaCap = Number(process.env.RADAR_DELTA_MAX_LISTINGS || maxListings || 120);
  const pages = Number.isFinite(deltaPages) && deltaPages > 0 ? Math.min(Math.floor(deltaPages), 5) : 3;
  const maxCap = Number.isFinite(deltaCap) && deltaCap > 0 ? Math.min(Math.floor(deltaCap), 300) : 120;

  const input = {
    regionIds: [String(regionId)],
    transaction: OFFER_MAP[offerType] || 'sale',
    category: CATEGORY_MAP[propertyType] || 'apartment',
    sort: 'newest',
    perPage: 60,
    maxListings: maxCap,
    // Delta scraping: jen první 2–3 strany nejnovějších (ne celý katalog)
    maxPagesPerTask: pages,
    requestDelay: 600,
    maxRetries: 3,
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'CZ',
    },
  };

  if (maxPrice != null && Number.isFinite(Number(maxPrice)) && Number(maxPrice) > 0) {
    input.priceMax = Math.floor(Number(maxPrice));
  }
  if (minArea != null && Number.isFinite(Number(minArea)) && Number(minArea) > 0) {
    input.usableAreaMin = Math.floor(Number(minArea));
  }

  const actorPath = encodeURIComponent(SREALITY_ACTOR);
  const url = `${APIFY_BASE}/acts/${actorPath}/runs?token=${encodeURIComponent(token)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Sreality Apify start chyba ${res.status}: ${errText.slice(0, 400)}`);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const data = await res.json();
  const runId = data?.data?.id;
  if (!runId) {
    const err = new Error('Apify nevrátil runId (Sreality)');
    err.status = 502;
    throw err;
  }

  console.log(`[Sreality Apify] Job spuštěn, runId: ${runId}, region=${region} (${regionId})`);
  return runId;
}

/** Normalizace výstupu logiover actoru do radar formátu. */
export function normalizeSrealityApifyListing(raw) {
  const listingId = String(raw.adId ?? raw.hash_id ?? raw.id ?? '').trim();
  const title = raw.title || raw.name || 'Bez názvu';
  const price = parsePrice(raw.price);
  const floorArea =
    raw.usableArea != null && Number.isFinite(Number(raw.usableArea))
      ? Number(raw.usableArea)
      : null;
  const landArea =
    raw.estateArea != null && Number.isFinite(Number(raw.estateArea))
      ? Number(raw.estateArea)
      : null;

  const imageUrls = Array.isArray(raw.imageUrls)
    ? raw.imageUrls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
    : raw.mainImageUrl
      ? [raw.mainImageUrl]
      : [];

  const layout =
    raw.subtype ||
    String(title).match(/(\d+\+(?:kk|\d))/i)?.[1] ||
    null;

  const lat = raw.latitude ?? raw.lat ?? null;
  const lon = raw.longitude ?? raw.lon ?? null;

  const agencyName = raw.agentName || raw.agencyName || raw.company || null;
  const publishedAt = raw.publishedAt || raw.published || raw.seo?.published || null;
  const daysOnPortal =
    publishedAt && Number.isFinite(Date.parse(publishedAt))
      ? Math.max(0, Math.floor((Date.now() - Date.parse(publishedAt)) / 86_400_000))
      : raw.daysOnPortal ?? raw.daysTracked ?? null;

  const pricePerSqm =
    raw.pricePerSqm != null && Number.isFinite(Number(raw.pricePerSqm))
      ? Math.round(Number(raw.pricePerSqm))
      : price && floorArea
        ? Math.round(price / floorArea)
        : null;

  return finishNormalizedListing(
    applyAgencySignals({
      listingId: listingId || `sreality-${Math.random().toString(36).slice(2, 10)}`,
      source: 'sreality',
      title,
      description: raw.description || '',
      price,
      pricePerSqm,
      locality: raw.locality || raw.city || raw.region || 'Neznámá lokalita',
      layout,
      floorArea,
      landArea,
      lat,
      lon,
      phone: raw.phone || raw.contactPhone || null,
      photoPHash: raw.photoPHash || raw.pHash || raw.imageHash || null,
      imageUrl: raw.mainImageUrl || imageUrls[0] || null,
      imageUrls,
      url: raw.detailUrl || raw.url || null,
      isNew: raw.isNew === true || (daysOnPortal != null && daysOnPortal <= 3),
      priceChanged: false,
      previousPrice: null,
      daysTracked: daysOnPortal,
      daysOnPortal,
      publishedAt,
      priceToMedianRatio: null,
      agencyName,
      brokerName: raw.agentName || null,
      sellerType:
        raw.rus === true || raw.isPrivateSeller === true
          ? 'private'
          : agencyName
            ? 'agency'
            : 'unknown',
      rus: raw.rus === true || raw.isPrivateSeller === true,
      hasVirtualTour: Boolean(raw.has3dTour || raw.hasVideo),
      hasProPhotos: imageUrls.length >= 8,
      scrapedAt: raw.scrapedAt || new Date().toISOString(),
      apifySource: true,
    }),
  );
}
