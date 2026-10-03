/**
 * Filtry Radaru — náběr vs. celý trh.
 */

const FSBO_SOURCES = new Set(['bazos', 'facebook', 'facebook_marketplace']);

/** Bezrealitky v Radaru neukazujeme (náběr z OP portálu). */
export function isExcludedRadarSource(listing) {
  const src = String(listing?.source || listing?.portal || '').toLowerCase();
  const url = String(listing?.url || '').toLowerCase();
  return src === 'bezrealitky' || url.includes('bezrealitky.cz');
}

export function dropExcludedRadarSources(listings) {
  if (!Array.isArray(listings)) return [];
  return listings.filter((l) => !isExcludedRadarSource(l));
}

/**
 * @param {'acquisition'|'market'} mode
 */
export function filterListingsForMode(listings, mode, options = {}) {
  if (mode === 'market') return listings;
  return listings.filter((l) => passesAcquisitionFilter(l, options));
}

/**
 * Přísný náběr — žádné aktivní RK inzeráty (< 90 dní).
 */
export function passesAcquisitionFilter(listing, { includeStaleAgency = true } = {}) {
  if (!listing || typeof listing !== 'object') return false;

  if (listing.radarStatus === 'DUPLICATE_RK' || listing.radarStatus === 'SUSPECTED_BROKER') {
    return false;
  }

  if (listing.isAgencyListing) {
    if (includeStaleAgency && (listing.daysOnPortal ?? 0) >= 90) return true;
    return false;
  }

  const src = String(listing.source || '').toLowerCase();

  if (FSBO_SOURCES.has(src)) {
    return !listing.isAgencyListing || Boolean(listing.fsboSignal);
  }

  if (src === 'sreality') {
    if (Boolean(listing.fsboSignal)) return true;
    if (listing.sellerType === 'private' && listing.listingKind === 'fsbo_explicit') return true;
    // Sreality rus=true = ověřený soukromník; samotné sellerType z list API nestačí
    if (listing.sellerType === 'private' && (listing._raw?.rus === true || listing.rus === true)) {
      return true;
    }
    return false;
  }

  return !listing.isAgencyListing;
}

/** Skrýt z náběru inzeráty se skóre 0 (zastoupeno RK) i když prošly filtrem. */
export function isAcquisitionViable(lead) {
  const score = lead?.ai?.score;
  if (score === 0) return false;
  if (lead?.radarStatus === 'DUPLICATE_RK' || lead?.radarStatus === 'SUSPECTED_BROKER') return false;
  if (lead?.isAgencyListing && (lead?.daysOnPortal ?? 0) < 90) return false;
  return true;
}
