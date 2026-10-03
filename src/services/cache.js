/**
 * Cache GeoPas — veřejné API pro zbytek backendu.
 */

export {
  getGeopasCacheEntry as getCachedAnalysis,
  setGeopasCacheEntry as cacheAnalysis,
  invalidateGeopasCache as invalidateCache,
  storePropertyAnalysisCache,
  loadPropertyAnalysisCache,
  loadSearchCache,
  storeSearchCache,
  getGeopasCacheStats as getCacheStats,
  getGeopasCacheStatsAsync,
  unwrapCachePayload,
  wrapCachePayload,
} from './geopasCacheStore.js';
