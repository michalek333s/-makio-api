/**
 * PostGIS ST_DWithin ≤ 500 m + plocha ±5 m² + cena ±10 % + dispozice.
 * Když RPC/PostGIS chybí, vrací [] — JS haversine zůstává fallback.
 */

export function isPostgisMatchEnabled() {
  return process.env.RADAR_POSTGIS_MATCH !== '0';
}

export function getPostgisMatchMax() {
  const n = Number(process.env.RADAR_POSTGIS_MATCH_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.min(200, Math.floor(n)) : 25;
}

function config() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return {
    enabled: isPostgisMatchEnabled() && Boolean(supabaseUrl && serviceKey),
    supabaseUrl,
    serviceKey,
  };
}

function headers(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

export function nearbyRowToListing(row) {
  if (!row) return null;
  return {
    listingId: row.id,
    id: row.id,
    source: row.source || 'sreality',
    url: row.source_url,
    sourceUrl: row.source_url,
    agencyName: row.agency_name,
    title: row.title,
    price: row.price != null ? Number(row.price) : null,
    floorArea: row.floor_area != null ? Number(row.floor_area) : null,
    layout: row.layout,
    lat: row.lat != null ? Number(row.lat) : null,
    lon: row.lng != null ? Number(row.lng) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    photoPHash: row.photo_phash,
    imageHashes: Array.isArray(row.image_hashes) ? row.image_hashes : [],
    isAgencyListing: true,
    distM: row.dist_m != null ? Number(row.dist_m) : null,
  };
}

export async function queryNearbyAgencyListings(listing, { radiusM = 500, limit = 20 } = {}) {
  const cfg = config();
  const lat = Number(listing?.lat ?? listing?.latitude);
  const lng = Number(listing?.lng ?? listing?.lon ?? listing?.longitude);
  if (!cfg.enabled || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  try {
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/match_agency_listings_nearby`, {
      method: 'POST',
      headers: headers(cfg.serviceKey),
      body: JSON.stringify({
        p_lat: lat,
        p_lng: lng,
        p_area: listing.floorArea ?? listing.floor_area ?? null,
        p_price: listing.price ?? null,
        p_layout: listing.layout || null,
        p_radius_m: radiusM,
        p_limit: limit,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const rows = await res.json().catch(() => []);
    return (Array.isArray(rows) ? rows : []).map(nearbyRowToListing).filter(Boolean);
  } catch (e) {
    console.warn('[Radar PostGIS]', e.message);
    return [];
  }
}

function hasCoords(listing) {
  const lat = Number(listing?.lat ?? listing?.latitude);
  const lng = Number(listing?.lng ?? listing?.lon ?? listing?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

/**
 * PostGIS nearby pro inzeráty se souřadnicemi — max RADAR_POSTGIS_MATCH_MAX RPC / scan.
 * Vrací unique RK reference k přimíchání do extraReferences.
 */
export async function collectNearbyAgencyReferences(listings, { max } = {}) {
  if (!isPostgisMatchEnabled()) return [];
  const cap = max ?? getPostgisMatchMax();
  if (cap <= 0 || !Array.isArray(listings) || listings.length === 0) return [];

  const out = [];
  const seen = new Set();
  let used = 0;
  for (const listing of listings) {
    if (used >= cap) break;
    if (!hasCoords(listing)) continue;
    used += 1;
    const nearby = await queryNearbyAgencyListings(listing);
    for (const row of nearby) {
      const key = row?.id || row?.listingId || row?.url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}
