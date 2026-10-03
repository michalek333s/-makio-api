/**
 * Apify — CZ Reality Scraper (asynchronní běh + dataset).
 * Token pouze v APIFY_TOKEN (.env).
 */

import { applyAgencySignals } from './listingAgency.js';
import { finishNormalizedListing } from '../lib/radarNormalize.js';

const ACTOR_ID = 'martas_kristof~cz-reality-scraper';
const APIFY_BASE = 'https://api.apify.com/v2';

function token() {
  const t = process.env.APIFY_TOKEN?.trim();
  if (!t) {
    const err = new Error('APIFY_TOKEN není nastaven v nemio-backend/.env');
    err.status = 503;
    throw err;
  }
  return t;
}

/** Actor vyžaduje offerType jako pole. */
function normalizeOfferType(value) {
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return ['prodej'];
}

/** Spustí Actor asynchronně, vrátí runId (obvykle do 1 s). */
export async function startRadarScrape(config) {
  const tok = token();
  const input = {
    portals: config.portals || ['sreality'],
    propertyCategory: config.propertyType || 'byty',
    offerType: normalizeOfferType(config.offerType),
    regions: config.regions || [],
    maxPrice: config.maxPrice ?? null,
    minFloorArea: config.minArea ?? null,
    maxListings: config.maxListings ?? 100,
    enableHistory: config.enableHistory ?? false,
  };

  const actorPath = encodeURIComponent(ACTOR_ID);
  const url = `${APIFY_BASE}/acts/${actorPath}/runs?token=${encodeURIComponent(tok)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Apify start chyba ${res.status}: ${errText.slice(0, 500)}`);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const data = await res.json();
  const runId = data?.data?.id;
  if (!runId) {
    const err = new Error('Apify nevrátil runId');
    err.status = 502;
    throw err;
  }

  console.log(`[Apify] Job spuštěn, runId: ${runId}`);
  return runId;
}

/** Stav běhu: RUNNING, SUCCEEDED, FAILED, TIMED-OUT, ABORTED, … */
export async function getRunStatus(runId) {
  const tok = token();
  const url = `${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(tok)}`;
  const res = await fetch(url);

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Apify status ${res.status}: ${errText.slice(0, 400)}`);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const data = await res.json();
  const d = data?.data;
  return {
    status: d?.status,
    itemCount: d?.stats?.itemCount ?? d?.stats?.outputItemCount ?? 0,
    datasetId: d?.defaultDatasetId,
    startedAt: d?.startedAt,
    finishedAt: d?.finishedAt,
  };
}

/** Položky default datasetu po dokončení runu. */
export async function getDatasetItems(datasetId) {
  const tok = token();
  if (!datasetId) {
    const err = new Error('Chybí defaultDatasetId u dokončeného běhu.');
    err.status = 502;
    throw err;
  }
  const url = `${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=true&token=${encodeURIComponent(tok)}`;
  const res = await fetch(url);

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Stažení datasetu ${res.status}: ${errText.slice(0, 400)}`);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

export function normalizeListing(raw) {
  const layoutFromName = raw.name?.match(/(\d\+(?:kk|\d))/)?.[1] || null;
  const listingId = raw.url?.split('/').pop() || raw.url || `tmp-${Math.random().toString(36).slice(2)}`;

  const imageUrls =
    Array.isArray(raw.imageUrls) && raw.imageUrls.length > 0
      ? raw.imageUrls.filter((u) => typeof u === 'string')
      : raw.imageUrl
        ? [raw.imageUrl]
        : [];

  return finishNormalizedListing(
    applyAgencySignals({
      listingId,
      source: raw.source,
      category: raw.category,
      title: raw.name,
      description: raw.description || raw.text || '',
      price: raw.price,
      pricePerSqm: raw.pricePerSqm,
      locality: raw.locality,
      layout: raw.layout || layoutFromName,
      floorArea: raw.floorArea,
      landArea: raw.landArea,
      lat: raw.lat,
      lon: raw.lon,
      phone: raw.phone || raw.tel || raw.contactPhone || null,
      photoPHash: raw.photoPHash || raw.pHash || raw.imageHash || null,
      imageUrl: raw.imageUrl ?? imageUrls[0] ?? null,
      imageUrls,
      url: raw.url,
      isNew: raw.isNew ?? null,
      priceChanged: raw.priceChanged ?? null,
      previousPrice: raw.previousPrice ?? null,
      daysTracked: raw.daysTracked ?? null,
      daysOnPortal: raw.daysOnPortal ?? raw.daysTracked ?? null,
      priceToMedianRatio: raw.priceToMedianRatio ?? null,
      agencyName: raw.agencyName || raw.company || null,
      scrapedAt: new Date().toISOString(),
    }),
  );
}

export function calculateMedianPrice(listings) {
  const prices = listings
    .map((l) => l.price)
    .filter((p) => typeof p === 'number' && p > 100_000)
    .sort((a, b) => a - b);

  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
}
