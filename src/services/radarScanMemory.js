/**
 * In-memory cache výsledků POST /radar/scan — invalidace po enrich.
 */

/** @type {Map<string, { data: object, cachedAt: number }>} */
export const radarScanMemoryCache = new Map();

export function invalidateRadarScanMemory(region, propertyType) {
  if (!region && !propertyType) {
    radarScanMemoryCache.clear();
    return;
  }
  const r = String(region || '');
  const p = String(propertyType || '');
  for (const key of [...radarScanMemoryCache.keys()]) {
    const hitRegion = !r || key.includes(r);
    const hitType = !p || key.includes(p);
    if (hitRegion && hitType) radarScanMemoryCache.delete(key);
  }
}
