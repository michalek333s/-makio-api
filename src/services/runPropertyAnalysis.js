import { getFullPropertyAnalysis } from './geopas.js';
import { calculateSafetyScore } from './scoring.js';
import { buildAnalysisResponse } from './propertyAnalysis.js';
import {
  loadPropertyAnalysisCache,
  storePropertyAnalysisCache,
} from './cache.js';
import { attachLocalityProfile } from './localityProfiles.js';
import { sanitizeAnalysisWsdpTest } from '../lib/wsdpTestMode.js';

function cacheTtlSeconds() {
  const hours = Number(process.env.GEOPAS_CACHE_TTL_HOURS || 168);
  return Number.isFinite(hours) && hours > 0 ? hours * 3600 : 168 * 3600;
}

async function decorateCached(entry, query, opts = {}) {
  const analysis = sanitizeAnalysisWsdpTest(entry.analysis || entry.data);
  const decorated = {
    ...analysis,
    fromCache: true,
    cacheSource: entry.source || 'memory',
    cacheHitKey: entry.hitKey || null,
    cachedAt: new Date(entry.cachedAt).toISOString(),
    cacheAgeMinutes: Math.max(0, Math.round((Date.now() - entry.cachedAt) / 60_000)),
    query,
  };
  return attachLocalityProfile(decorated, opts);
}

async function buildFromGeopasRaw(geopasRaw, query, opts = {}) {
  geopasRaw.query = query;
  const safetyScore = calculateSafetyScore(geopasRaw);
  const result = sanitizeAnalysisWsdpTest(buildAnalysisResponse(geopasRaw, safetyScore));
  result.query = query;
  result.fromCache = false;
  result.builtFromRawCache = true;
  return attachLocalityProfile(result, opts);
}

/**
 * Jednotný vstup pro /api/property/analyze i AI chat.
 * Při cache hit = 0 GeoPas volání.
 */
export async function runPropertyAnalysis(
  query,
  { useCache = true, refresh = false, userId = null, code = null, type = null } = {},
) {
  const q = String(query || '').trim();
  if (!q && !code) throw new Error('Chybí dotaz (adresa nebo parcela).');

  const shouldCache = useCache && !refresh;
  const locOpts = { userId };
  const cacheKey = q || `${type || 'entity'}:${code}`;

  if (shouldCache) {
    const cached = await loadPropertyAnalysisCache(cacheKey);
    if (cached?.analysis) {
      console.log(`[GeoPas cache] HIT analysis ${cached.hitKey || '?'}`);
      return decorateCached(cached, cacheKey, locOpts);
    }
    if (cached?.geopasRaw) {
      console.log(`[GeoPas cache] HIT raw → rebuild ${cached.hitKey || '?'}`);
      const result = await buildFromGeopasRaw(cached.geopasRaw, cacheKey, locOpts);
      await storePropertyAnalysisCache(cacheKey, result, cached.geopasRaw, cacheTtlSeconds());
      return { ...result, fromCache: true, cacheSource: cached.source || 'memory' };
    }
  }

  console.log(`[GeoPas cache] MISS → GeoPas API pro: ${String(cacheKey).slice(0, 60)}`);
  const geopasData = await getFullPropertyAnalysis(cacheKey, {
    useCache: shouldCache,
    code,
    type,
  });
  geopasData.query = cacheKey;
  const safetyScore = calculateSafetyScore(geopasData);
  const result = sanitizeAnalysisWsdpTest(buildAnalysisResponse(geopasData, safetyScore));
  result.query = cacheKey;
  result.fromCache = false;
  await attachLocalityProfile(result, locOpts);

  if (shouldCache) {
    await storePropertyAnalysisCache(cacheKey, result, geopasData, cacheTtlSeconds());
  }

  return result;
}
