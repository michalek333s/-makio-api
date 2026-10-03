/**
 * In-process fronta ingestu Radar v2 (bez Redis/BullMQ).
 * Normalizace → validace → oddělení private vs. RK reference streamů.
 */

import { finishNormalizedListing, normalizeCzPhone, radarStreamForSource } from '../lib/radarNormalize.js';
import { RADAR_STATUS, validateRadarListing, buildRecentByPhone } from './radarValidate.js';

/** @type {Set<string>} */
const memoryBlacklist = new Set();

/** @type {Array<object>} */
const queue = [];
let draining = false;

export function getMemoryBlacklist() {
  return new Set(memoryBlacklist);
}

export function addToMemoryBlacklist(phone, _reason = '') {
  const n = normalizeCzPhone(phone);
  if (n) memoryBlacklist.add(n);
  return n;
}

export function seedMemoryBlacklist(phones = []) {
  for (const p of phones) addToMemoryBlacklist(p);
}

export function listingToPrivateRow(listing, validation) {
  return {
    source: listing.source,
    source_url: listing.sourceUrl || listing.url,
    listing_external_id: listing.listingId != null ? String(listing.listingId) : null,
    title: listing.title || null,
    description: listing.description || null,
    price: listing.price ?? null,
    floor_area: listing.floorArea ?? null,
    layout: listing.layout || null,
    locality: listing.locality || null,
    city: listing.city || null,
    region: listing.region || null,
    phone_e164: listing.phoneE164 || null,
    lat: listing.lat ?? null,
    lng: listing.lng ?? listing.lon ?? null,
    photo_phash: listing.photoPHash || listing.pHash || listing.imageHash || listing.imageHashes?.[0] || null,
    image_urls: Array.isArray(listing.imageUrls)
      ? listing.imageUrls
      : Array.isArray(listing.image_urls)
        ? listing.image_urls
        : listing.imageUrl
          ? [listing.imageUrl]
          : [],
    image_hashes: Array.isArray(listing.imageHashes)
      ? listing.imageHashes
      : Array.isArray(listing.image_hashes)
        ? listing.image_hashes
        : [],
    contact_name: listing.contactName || listing.contact_name || null,
    status: validation.status || null,
    match_confidence: validation.matchConfidence ?? null,
    matched_agency_listing_id: validation.matchedAgencyListingId || null,
    matched_agency_url: validation.matchedAgencyUrl || null,
    reasons: validation.reasons || [],
    payload: listing,
    scraped_at: listing.scrapedAt || new Date().toISOString(),
    validated_at: new Date().toISOString(),
  };
}

export function listingToReferenceRow(listing) {
  return {
    source: listing.source,
    source_url: listing.sourceUrl || listing.url,
    listing_external_id: listing.listingId != null ? String(listing.listingId) : null,
    title: listing.title || null,
    price: listing.price ?? null,
    floor_area: listing.floorArea ?? null,
    layout: listing.layout || null,
    locality: listing.locality || null,
    city: listing.city || null,
    region: listing.region || null,
    lat: listing.lat ?? null,
    lng: listing.lng ?? listing.lon ?? null,
    photo_phash: listing.photoPHash || listing.pHash || listing.imageHash || listing.imageHashes?.[0] || null,
    image_urls: Array.isArray(listing.imageUrls)
      ? listing.imageUrls
      : Array.isArray(listing.image_urls)
        ? listing.image_urls
        : listing.imageUrl
          ? [listing.imageUrl]
          : [],
    image_hashes: Array.isArray(listing.imageHashes)
      ? listing.imageHashes
      : Array.isArray(listing.image_hashes)
        ? listing.image_hashes
        : [],
    agency_name: listing.agencyName || null,
    payload: listing,
    scraped_at: listing.scrapedAt || new Date().toISOString(),
  };
}

/**
 * Jedna položka: normalizace + validace. Neukládá do DB (to je Sprint 2 ingest worker).
 */
export function ingestRadarListing(raw, ctx = {}) {
  const listing = finishNormalizedListing(raw);
  const stream = listing.radarStream || radarStreamForSource(listing.source);
  const validation = validateRadarListing(listing, {
    blacklist: ctx.blacklist !== undefined ? ctx.blacklist : memoryBlacklist,
    referenceListings: ctx.referenceListings || [],
    recentByPhone: ctx.recentByPhone,
  });

  if (validation.autoBlacklist?.phone) {
    addToMemoryBlacklist(validation.autoBlacklist.phone, validation.autoBlacklist.reason);
  }

  const enriched = {
    ...listing,
    radarStatus: validation.status,
    radarMatchConfidence: validation.matchConfidence,
    matchedAgencyListingId: validation.matchedAgencyListingId,
    matchedAgencyUrl: validation.matchedAgencyUrl,
    matchedAgencyName: validation.matchedAgencyName,
    radarReasons: validation.reasons,
    radarStream: stream,
  };

  return {
    listing: enriched,
    stream,
    validation,
    privateRow: stream === 'private' ? listingToPrivateRow(enriched, validation) : null,
    referenceRow: stream === 'reference' ? listingToReferenceRow(enriched) : null,
  };
}

export function ingestRadarBatch(rawListings, { referenceListings = [], blacklist } = {}) {
  const finished = (Array.isArray(rawListings) ? rawListings : []).map((l) => finishNormalizedListing(l));
  const refs = [
    ...referenceListings.map((l) => finishNormalizedListing(l)),
    ...finished.filter((l) => (l.radarStream || radarStreamForSource(l.source)) === 'reference'),
  ];
  const recentByPhone = buildRecentByPhone([...finished, ...refs]);
  return finished.map((raw) =>
    ingestRadarListing(raw, {
      blacklist: blacklist !== undefined ? blacklist : memoryBlacklist,
      referenceListings: refs,
      recentByPhone,
    }),
  );
}

export function enqueueRadarListing(raw, ctx = {}) {
  queue.push({ raw, ctx, enqueuedAt: Date.now() });
  scheduleDrain();
  return queue.length;
}

export function getRadarQueueSize() {
  return queue.length;
}

function scheduleDrain() {
  if (draining) return;
  draining = true;
  setTimeout(() => {
    drainRadarQueue().finally(() => {
      draining = false;
      if (queue.length) scheduleDrain();
    });
  }, 0);
}

export async function drainRadarQueue({ referenceListings = [] } = {}) {
  const batch = queue.splice(0, queue.length);
  if (!batch.length) return [];
  const raws = batch.map((b) => b.raw);
  return ingestRadarBatch(raws, { referenceListings });
}

/**
 * Už zvalidované inzeráty → řádky pro persist (bez druhého kola filtru).
 */
export function listingsToIngestShape(listings = []) {
  return listings.map((raw) => {
    const listing = finishNormalizedListing(raw);
    const stream = listing.radarStream || radarStreamForSource(listing.source);
    const isRef = stream === 'reference' || (listing.isAgencyListing && !listing.fsboSignal);
    const validation = {
      status: listing.radarStatus || null,
      matchConfidence: listing.radarMatchConfidence ?? null,
      matchedAgencyListingId: listing.matchedAgencyListingId || null,
      matchedAgencyUrl: listing.matchedAgencyUrl || null,
      matchedAgencyName: listing.matchedAgencyName || null,
      reasons: listing.radarReasons || [],
    };
    return {
      listing,
      stream: isRef ? 'reference' : stream,
      validation,
      privateRow: isRef ? null : listingToPrivateRow(listing, validation),
      referenceRow: isRef ? listingToReferenceRow(listing) : null,
    };
  });
}
