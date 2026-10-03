/**
 * Stabilní klíč pro GeoPas cache — stejná adresa v různém zápisu → stejný klíč.
 */
export function normalizeCacheKey(query) {
  const body = String(query || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[,.;/\\-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 200);
  // v3 = parcel/KÚ disambiguace (ne první 2201/1 z náhodné obce)
  return body ? `v3_${body}` : body;
}

export function parcelCacheKey(parcelId) {
  if (parcelId == null || parcelId === '') return null;
  return `v3_parcel_${String(parcelId).trim()}`;
}
