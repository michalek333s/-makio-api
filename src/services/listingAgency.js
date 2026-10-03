/**
 * Detekce realitní kanceláře vs. soukromník (FSBO) u inzerátů.
 */

const AGENCY_TITLE_RE =
  /\b(realit(?:ní|ka)?\s+kancel|zprostředkujeme|provize\s+\d|naše\s+rk|rk\s+[a-záčďéěíňóřšťúůýž]|mm\s+reality|remax|re\/max|century\s*21|viola|luxor|m[&\s]*m\s+reality|era\s+real|coldwell|kw\s+real|orion|dumrealit|top\s+reality)\b/iu;

const FSBO_TITLE_RE =
  /\b(bez\s+rk|bez\s+realit|nevolat\s+rk|rk\s+nevolat|prod[aá]m\s+s[aá]m|soukrom[eě]|jen\s+seri[oó]zní\s+kupující|bez\s+makléř)\b/iu;

const KNOWN_AGENCY_NAMES = [
  'mm reality',
  're/max',
  'remax',
  'century',
  'viola',
  'luxor',
  'era ',
  'orion',
  'dumrealit',
  'top reality',
  'coldwell',
  'kw ',
  'finreality',
  'reality ',
  'realitní kancel',
  'g8 reality',
  'next reality',
  'stavba',
  'arkády',
  'reality cz',
  'svoboda',
  'maxima',
  'direct reality',
  'reality partner',
];

const FSBO_SOURCES = new Set(['bazos', 'bezrealitky', 'facebook', 'facebook_marketplace']);

function inferSellerType(listing) {
  if (listing.sellerType) return listing.sellerType;
  const raw = listing._raw || listing;
  if (raw.rus === true) return 'private';
  if (raw.premise?.id || raw.premise_id || raw.premiseId) return 'agency';
  if (raw.seller?.type === 1 || raw.seller_type === 'private') return 'private';
  if (raw.seller?.type === 2 || raw.seller_type === 'agency') return 'agency';
  return 'unknown';
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

function pickCompanyName(raw) {
  const c = raw?.company;
  if (!c) return null;
  if (typeof c === 'string' && c.trim()) return c.trim();
  if (typeof c?.name === 'string' && c.name.trim()) return c.name.trim();
  if (typeof c?.name?.value === 'string' && c.name.value.trim()) return c.name.value.trim();
  return null;
}

function pickBrokerName(raw) {
  const b = raw?.broker;
  if (!b) return null;
  if (typeof b?.name === 'string' && b.name.trim()) return b.name.trim();
  if (typeof b?.name?.value === 'string' && b.name.value.trim()) return b.name.value.trim();
  return null;
}

function daysSince(isoOrMs) {
  if (!isoOrMs) return null;
  const t = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * @param {object} listing — normalizovaný nebo raw Sreality záznam
 */
export function detectListingAgency(listing = {}) {
  const title = listing.title || listing.name || '';
  const description = listing.description || '';
  const blob = `${title} ${description}`;
  const blobNorm = norm(blob);

  const companyName = listing.agencyName || pickCompanyName(listing) || pickCompanyName(listing._raw);
  const brokerName = listing.brokerName || pickBrokerName(listing) || pickBrokerName(listing._raw);

  let isAgencyListing = Boolean(listing.isAgencyListing);
  let agencyName = companyName || brokerName || listing.agencyName || null;
  let fsboSignal = Boolean(listing.fsboSignal);

  if (FSBO_TITLE_RE.test(blob)) {
    fsboSignal = true;
    if (!companyName && !brokerName) isAgencyListing = false;
  }

  if (companyName || brokerName) {
    isAgencyListing = true;
    agencyName = companyName || brokerName;
  }

  if (!isAgencyListing && AGENCY_TITLE_RE.test(blob)) {
    isAgencyListing = true;
    agencyName = agencyName || 'RK (detekováno z textu)';
  }

  if (!isAgencyListing && agencyName) {
    const agencyNorm = norm(agencyName);
    if (KNOWN_AGENCY_NAMES.some((k) => agencyNorm.includes(norm(k)))) {
      isAgencyListing = true;
    }
  }

  if (fsboSignal && !companyName && !brokerName) {
    isAgencyListing = false;
    agencyName = null;
  }

  const source = String(listing.source || '').toLowerCase();
  const sellerType = inferSellerType(listing);

  if (FSBO_SOURCES.has(source)) {
    if (!companyName && !brokerName && !AGENCY_TITLE_RE.test(blob)) {
      isAgencyListing = false;
      if (!agencyName) agencyName = null;
    }
  } else if (source === 'sreality' && !fsboSignal) {
    if (sellerType === 'private') {
      isAgencyListing = false;
    } else if (!companyName && !brokerName && sellerType !== 'private') {
      isAgencyListing = true;
      agencyName = agencyName || 'RK (Sreality)';
    }
  }

  const published =
    listing.publishedAt ||
    listing.published ||
    listing._raw?.published ||
    listing._raw?.seo?.published;
  const daysOnPortal =
    listing.daysOnPortal ??
    listing.daysTracked ??
    (published ? daysSince(published) : null);

  const hasVirtualTour = Boolean(
    listing.hasVirtualTour ||
      listing._raw?.has_matterport_url ||
      listing._raw?.matterport_url ||
      /virtual/i.test(blob),
  );
  const imageCount = Array.isArray(listing.imageUrls)
    ? listing.imageUrls.length
    : listing.imageUrl
      ? 1
      : 0;
  const hasProPhotos = Boolean(listing.hasProPhotos || imageCount >= 8 || hasVirtualTour);

  return {
    isAgencyListing,
    agencyName,
    fsboSignal,
    sellerType,
    daysOnPortal,
    hasVirtualTour,
    hasProPhotos,
    listingKind: isAgencyListing
      ? daysOnPortal != null && daysOnPortal >= 90
        ? 'stale_agency'
        : 'agency'
      : fsboSignal
        ? 'fsbo_explicit'
        : 'fsbo_likely',
  };
}

/** @param {object} listing */
export function applyAgencySignals(listing) {
  const signals = detectListingAgency(listing);
  return { ...listing, ...signals };
}

/** Výchozí scan — jen soukromníci + staré RK (náběr po konkurenci). */
export function passesFsboFilter(listing, { fsboOnly = true, includeStaleAgency = false } = {}) {
  if (!fsboOnly) return true;
  if (!listing.isAgencyListing) return true;
  if (includeStaleAgency && (listing.daysOnPortal ?? 0) >= 90) return true;
  return false;
}
