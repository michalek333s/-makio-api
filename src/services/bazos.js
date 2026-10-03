/**
 * Bazoš přes Apify — pouze asynchronně (nightly / enrich), ne do rychlého scanu.
 */

import { applyAgencySignals } from './listingAgency.js';
import { finishNormalizedListing } from '../lib/radarNormalize.js';

const BAZOS_ACTOR = process.env.RADAR_BAZOS_ACTOR?.trim() || 'vzahajsky~bazos-scraper';
const APIFY_BASE = 'https://api.apify.com/v2';

export const BAZOS_QUERIES = {
  byty: ['prodej byt', 'prodám byt', 'byt na prodej', 'prodám apartmán'],
  domy: ['prodej dům', 'prodám dům', 'rodinný dům na prodej', 'prodám rodinný dům'],
  pozemky: ['prodej pozemek', 'prodám pozemek', 'stavební pozemek'],
};

function apifyToken() {
  const t = process.env.APIFY_TOKEN?.trim();
  if (!t) {
    const err = new Error('APIFY_TOKEN není nastaven v nemio-backend/.env');
    err.status = 503;
    throw err;
  }
  return t;
}

export async function startBazosScrape({ region, propertyType = 'byty' } = {}) {
  if (process.env.RADAR_BAZOS_ENABLED === '0') {
    return null;
  }

  const token = apifyToken();
  const queries = BAZOS_QUERIES[propertyType] || BAZOS_QUERIES.byty;
  const searchQueries = queries.map((q) => (region ? `${q} ${region}` : q));

  const maxItems = Math.min(
    150,
    Math.max(20, Number(process.env.RADAR_BAZOS_MAX_ITEMS || 60) || 60),
  );

  const input = {
    queries: searchQueries,
    maxItems,
    proxyConfig: { useApifyProxy: true },
  };

  const actorPath = encodeURIComponent(BAZOS_ACTOR);
  const url = `${APIFY_BASE}/acts/${actorPath}/runs?token=${encodeURIComponent(token)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 403 && errText.includes('full-permission-actor-not-approved')) {
      const err = new Error(
        'Bazoš actor vyžaduje schválení v Apify konzoli — enrich pokračuje bez Bazoše.',
      );
      err.code = 'BAZOS_PERMISSIONS';
      err.approvalHint = errText.slice(0, 300);
      throw err;
    }
    const err = new Error(`Bazoš Apify start chyba ${res.status}: ${errText.slice(0, 400)}`);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const data = await res.json();
  const runId = data?.data?.id;
  if (!runId) {
    const err = new Error('Apify nevrátil runId (Bazoš)');
    err.status = 502;
    throw err;
  }
  return runId;
}

export function normalizeBazosListing(raw) {
  const title = raw.title || raw.name || '';
  const priceMatch = String(raw.price || '')
    .replace(/\s/g, '')
    .match(/(\d+)/);
  const price = priceMatch ? parseInt(priceMatch[1], 10) : null;

  const blob = `${title} ${raw.description || ''}`;
  const areaMatch = blob.match(/(\d{2,4})\s*m²/i);
  const layoutMatch = blob.match(/(\d+\+(?:kk|\d))/i);

  const slug = raw.url?.split('/').filter(Boolean).pop() || String(Math.random()).slice(2);

  const imageUrls = Array.isArray(raw.images)
    ? raw.images.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
    : raw.image && typeof raw.image === 'string'
      ? [raw.image]
      : [];

  return finishNormalizedListing(
    applyAgencySignals({
      listingId: `bazos-${slug}`,
      source: 'bazos',
      title,
      description: raw.description || '',
      price,
      pricePerSqm: null,
      locality: raw.location || raw.city || '',
      layout: layoutMatch?.[1] || null,
      floorArea: areaMatch ? parseInt(areaMatch[1], 10) : null,
      landArea: null,
      lat: raw.lat ?? raw.latitude ?? null,
      lon: raw.lon ?? raw.lng ?? raw.longitude ?? null,
      phone: raw.phone || raw.tel || raw.contact || null,
      photoPHash: raw.photoPHash || raw.pHash || raw.imageHash || null,
      imageUrl: imageUrls[0] || raw.image || null,
      imageUrls,
      url: raw.url,
      isNew: false,
      priceChanged: false,
      previousPrice: null,
      daysTracked: null,
      priceToMedianRatio: null,
      scrapedAt: new Date().toISOString(),
    }),
  );
}
