/**
 * Facebook Marketplace přes Apify — enrich-only (jako Bazoš).
 * Mapuje oficiální výstup actoru (snake_case i camelCase, vnořené listing_price / location).
 */

import { applyAgencySignals } from './listingAgency.js';
import {
  finishNormalizedListing,
  localityToString,
  parsePriceCzk,
} from '../lib/radarNormalize.js';
import { facebookMarketplaceUrls } from '../lib/radarRegions.js';

const FB_ACTOR =
  process.env.RADAR_FB_ACTOR?.trim() || 'apify~facebook-marketplace-scraper';
const APIFY_BASE = 'https://api.apify.com/v2';

function apifyToken() {
  const t = process.env.APIFY_TOKEN?.trim();
  if (!t) {
    const err = new Error('APIFY_TOKEN není nastaven v nemio-backend/.env');
    err.status = 503;
    throw err;
  }
  return t;
}

function pickText(...candidates) {
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (typeof c === 'object') {
      const nested = pickText(c.text, c.value, c.title, c.name);
      if (nested) return nested;
    }
  }
  return '';
}

function facebookLocality(raw) {
  const loc = raw.location;
  const fromGeo =
    loc?.reverse_geocode?.city ||
    loc?.reverse_geocode?.city_page?.display_name ||
    loc?.city;
  return (
    pickText(
      raw.locationText,
      raw.location_text,
      fromGeo,
      typeof loc === 'string' ? loc : '',
      raw.city,
      raw.marketplace_listing_location,
    ) || localityToString(loc)
  );
}

function collectImages(raw) {
  const images = [];
  const push = (u) => {
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) images.push(u);
  };
  push(raw.primary_listing_photo?.image?.uri);
  push(raw.primary_listing_photo?.uri);
  push(raw.image);
  push(raw.thumbnail);
  push(raw.mainImageUrl);
  const lists = [raw.listingPhotos, raw.listing_photos, raw.images, raw.photos];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const img of list) {
      push(typeof img === 'string' ? img : img?.image?.uri || img?.uri || img?.url);
    }
  }
  return [...new Set(images)].slice(0, 20);
}

function looksLikeListingRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  return Boolean(
    row.marketplace_listing_title ||
      row.listingTitle ||
      row.listing_title ||
      row.listing_price ||
      row.listingPrice ||
      row.primary_listing_photo ||
      row.listingUrl ||
      row.itemUrl ||
      (row.id && (row.location || row.listingPhotos)),
  );
}

/**
 * Apify občas vrací obal `{ query: [listings] }` nebo `deep_scraped: []`.
 */
export function unwrapFacebookDatasetItems(item) {
  if (item == null) return [];
  if (Array.isArray(item)) return item.flatMap(unwrapFacebookDatasetItems);
  if (typeof item !== 'object') return [];
  if (looksLikeListingRow(item)) return [item];
  if (item.is_sold === true || item.type === 'area_summary') return [];
  if (Array.isArray(item.listings)) return item.listings.flatMap(unwrapFacebookDatasetItems);
  if (Array.isArray(item.deep_scraped)) return item.deep_scraped.flatMap(unwrapFacebookDatasetItems);
  const nestedArrays = Object.entries(item)
    .filter(([k, v]) => Array.isArray(v) && !['images', 'photos', 'listingPhotos', 'listing_photos'].includes(k))
    .map(([, v]) => v);
  if (nestedArrays.length && !item.id) {
    return nestedArrays.flatMap(unwrapFacebookDatasetItems);
  }
  return [item];
}

export async function startFacebookMarketplaceScrape({ region, propertyType = 'byty' } = {}) {
  if (process.env.RADAR_FB_ENABLED === '0') {
    return null;
  }

  const token = apifyToken();
  const urls = facebookMarketplaceUrls(region, propertyType);
  if (!urls.length) {
    return null;
  }

  const maxItems = Number(process.env.RADAR_FB_MAX_ITEMS || 80);
  const input = {
    startUrls: urls.map((url) => ({ url })),
    resultsLimit: Number.isFinite(maxItems) ? Math.min(maxItems, 200) : 80,
    deepScrape: false,
    proxyConfiguration: { useApifyProxy: true },
  };

  const actorPath = encodeURIComponent(FB_ACTOR);
  const url = `${APIFY_BASE}/acts/${actorPath}/runs?token=${encodeURIComponent(token)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Facebook Apify start chyba ${res.status}: ${errText.slice(0, 400)}`);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    if (res.status === 403) err.code = 'FB_PERMISSIONS';
    throw err;
  }

  const data = await res.json();
  const runId = data?.data?.id;
  if (!runId) {
    const err = new Error('Apify nevrátil runId (Facebook)');
    err.status = 502;
    throw err;
  }

  console.log(`[Facebook Apify] Job spuštěn, runId: ${runId}, region=${region}`);
  return runId;
}

export function normalizeFacebookListing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.is_sold === true || raw.isSold === true) return null;
  if (raw.type === 'area_summary') return null;

  const title = pickText(
    raw.marketplace_listing_title,
    raw.listingTitle,
    raw.listing_title,
    raw.custom_title,
    raw.title,
    raw.name,
  );
  const description = pickText(
    raw.description,
    raw.redacted_description,
    raw.marketplace_listing_description,
  );
  const price = parsePriceCzk(
    raw.listing_price || raw.listingPrice || raw.price || raw.priceText || raw.listing_price?.amount,
  );
  const images = collectImages(raw);
  const explicitUrl =
    raw.listingUrl || raw.itemUrl || raw.url || raw.facebookUrl || null;

  if (!title && price == null && images.length === 0) return null;

  const url =
    explicitUrl || (raw.id ? `https://www.facebook.com/marketplace/item/${raw.id}` : null);

  const listingId = String(
    raw.id || raw.listing_id || (url ? String(url).split('/').filter(Boolean).pop() : '') || `fb-${Math.random().toString(36).slice(2, 9)}`,
  );

  const locality = facebookLocality(raw);
  const blob = `${title} ${description}`;
  const layout = String(blob).match(/(\d)\s*\+\s*(kk|\d)/i);
  const layoutNorm = layout ? `${layout[1]}+${layout[2].toLowerCase()}` : null;
  const areaMatch = blob.match(/(\d{1,4})\s*m[²2]/i);
  const floorArea = areaMatch ? parseInt(areaMatch[1], 10) : null;
  const lat = raw.location?.latitude ?? raw.lat ?? null;
  const lon = raw.location?.longitude ?? raw.lon ?? raw.lng ?? null;
  const publishedAt = raw.timestamp || raw.creation_time || raw.createdAt || null;
  const sellerName = pickText(raw.marketplace_listing_seller?.name, raw.sellerName, raw.seller?.name);

  return finishNormalizedListing(
    applyAgencySignals({
      listingId: `facebook-${listingId}`,
      source: 'facebook',
      title,
      description,
      price,
      pricePerSqm: price && floorArea ? Math.round(price / floorArea) : null,
      locality,
      layout: layoutNorm,
      floorArea,
      lat,
      lon,
      lng: lon,
      phone: raw.phone || raw.phoneNumber || null,
      contactName: sellerName || null,
      photoPHash: raw.photoPHash || raw.pHash || null,
      url,
      imageUrl: images[0] || null,
      imageUrls: images,
      publishedAt,
      scrapedAt: new Date().toISOString(),
      foundOnPortals: ['facebook'],
      isNew: true,
    }),
  );
}
