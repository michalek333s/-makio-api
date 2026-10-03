/**
 * Radar v2 evaluateListing — 3 stupně (metadata → PostGIS/parametry → pHash).
 * Stack je Express, ne Next.js. TypeScript typy jsou v JSDoc.
 */

import { finishNormalizedListing } from '../radarNormalize.js';
import { queryNearbyAgencyListings } from '../../services/radarPostgisMatch.js';
import { calculatePhashes } from '../../services/radarPHash.js';
import { validateRadarListing } from '../../services/radarValidate.js';

/**
 * @typedef {object} RawListingInput
 * @property {string} [source]
 * @property {string} [url]
 * @property {string} [title]
 * @property {string} [description]
 * @property {number} [price]
 * @property {number} [floorArea]
 * @property {string} [layout]
 * @property {number} [lat]
 * @property {number} [lng]
 * @property {string} [phone]
 * @property {string[]} [imageUrls]
 */

/**
 * @param {RawListingInput} raw
 * @param {{ blacklist?: Set|Array, referenceListings?: object[], hashImages?: boolean }} [ctx]
 */
export async function evaluateListing(raw, ctx = {}) {
  const listing = finishNormalizedListing(raw);
  let hashed = listing;
  if (ctx.hashImages && (!listing.photoPHash && !(listing.imageHashes || []).length)) {
    const urls = listing.imageUrls || listing.image_urls || [];
    const hashes = await calculatePhashes(urls, { max: 3 });
    if (hashes.length) {
      hashed = { ...listing, photoPHash: hashes[0], imageHashes: hashes };
    }
  }

  let refs = Array.isArray(ctx.referenceListings) ? [...ctx.referenceListings] : [];
  if (!ctx.skipPostgis) {
    const nearby = await queryNearbyAgencyListings(hashed);
    if (nearby.length) refs = [...nearby, ...refs];
  }

  const result = validateRadarListing(hashed, {
    blacklist: ctx.blacklist,
    referenceListings: refs,
    recentByPhone: ctx.recentByPhone,
  });

  return {
    listing: {
      ...hashed,
      radarStatus: result.status,
      radarMatchConfidence: result.matchConfidence,
      matchedAgencyListingId: result.matchedAgencyListingId,
      matchedAgencyUrl: result.matchedAgencyUrl,
      matchedAgencyName: result.matchedAgencyName,
      radarReasons: result.reasons,
    },
    ...result,
  };
}

export { validateRadarListing } from '../../services/radarValidate.js';
export { hammingDistance, calculatePhash, findPHashMatch } from '../../services/radarPHash.js';
