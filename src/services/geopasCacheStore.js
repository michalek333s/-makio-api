/**
 * Vrstvená cache GeoPas — vše katastrické volání ukládat, neplatit znovu.
 * L1 RAM + L2 Supabase (geopas_analysis_cache, migrace 0015)
 */

import { normalizeCacheKey, parcelCacheKey } from '../lib/normalizeCacheKey.js';
import { diskCacheGet, diskCacheSet, diskCacheStats, diskCacheEnabled } from './geopasDiskCache.js';

const memory = new Map();
let stats = { hits: 0, misses: 0, writes: 0, diskHits: 0, diskWrites: 0 };

function cacheConfig() {
  const ttlHours = Number(process.env.GEOPAS_CACHE_TTL_HOURS || 168);
  const searchTtlHours = Number(process.env.GEOPAS_SEARCH_CACHE_TTL_HOURS || 24);
  const ttlSeconds = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours * 3600 : 168 * 3600;
  const searchTtlSeconds =
    Number.isFinite(searchTtlHours) && searchTtlHours > 0 ? searchTtlHours * 3600 : 86400;
  const enabled = process.env.GEOPAS_CACHE_ENABLED !== '0' && process.env.GEOPAS_CACHE_ENABLED !== 'false';
  const backend = String(process.env.GEOPAS_CACHE_BACKEND || 'layered').trim().toLowerCase();
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const useSupabase =
    (backend === 'supabase' || backend === 'layered') && Boolean(supabaseUrl && serviceKey);

  return { enabled, ttlSeconds, searchTtlSeconds, useSupabase, supabaseUrl, serviceKey, backend, ttlHours };
}

function supabaseHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

async function supabaseGet(key, { supabaseUrl, serviceKey }) {
  const now = new Date().toISOString();
  const url =
    `${supabaseUrl}/rest/v1/geopas_analysis_cache` +
    `?cache_key=eq.${encodeURIComponent(key)}` +
    `&expires_at=gt.${encodeURIComponent(now)}` +
    `&select=cache_key,payload,cached_at,expires_at` +
    `&limit=1`;

  const res = await fetch(url, { headers: supabaseHeaders(serviceKey) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn('[GeoPas cache] Supabase read:', res.status, text.slice(0, 200));
    return null;
  }
  const rows = await res.json();
  const row = rows?.[0];
  if (!row?.payload) return null;

  return {
    data: row.payload,
    cachedAt: new Date(row.cached_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
    source: 'supabase',
  };
}

async function supabaseSet(key, entry, meta, { supabaseUrl, serviceKey }) {
  const body = {
    cache_key: key,
    query_text: meta.query || null,
    parcel_id: meta.parcelId ?? null,
    address: meta.address || null,
    payload: entry.data,
    cached_at: new Date(entry.cachedAt).toISOString(),
    expires_at: new Date(entry.expiresAt).toISOString(),
  };

  const res = await fetch(`${supabaseUrl}/rest/v1/geopas_analysis_cache?on_conflict=cache_key`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(serviceKey),
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn('[GeoPas cache] Supabase write:', res.status, text.slice(0, 200));
    return false;
  }
  return true;
}

function memoryGet(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memory.delete(key);
    return null;
  }
  return { ...entry, source: 'memory' };
}

function memorySet(key, entry) {
  memory.set(key, entry);
}

function memoryDelete(key) {
  memory.delete(key);
}

/** Normalizace uloženého payloadu (starý formát = jen analysis objekt). */
export function unwrapCachePayload(data) {
  if (!data) return { analysis: null, geopasRaw: null };
  if (data.version === 2) {
    return { analysis: data.analysis ?? null, geopasRaw: data.geopasRaw ?? null };
  }
  return { analysis: data, geopasRaw: null };
}

export function wrapCachePayload(analysis, geopasRaw = null) {
  return { version: 2, analysis, geopasRaw };
}

/**
 * @param {string} key
 * @param {string[]} [aliasKeys]
 */
export async function getGeopasCacheEntry(key, { aliasKeys = [] } = {}) {
  const cfg = cacheConfig();
  if (!cfg.enabled || !key) return null;

  const keys = [key, ...aliasKeys.filter(Boolean)];

  for (const k of keys) {
    const mem = memoryGet(k);
    if (mem) {
      stats.hits++;
      return { ...mem, hitKey: k };
    }
  }

  if (cfg.useSupabase) {
    for (const k of keys) {
      try {
        const row = await supabaseGet(k, cfg);
        if (row) {
          memorySet(k, row);
          stats.hits++;
          return { ...row, hitKey: k };
        }
      } catch (e) {
        console.warn('[GeoPas cache] Supabase get failed:', e.message);
      }
    }
  }

  if (diskCacheEnabled()) {
    for (const k of keys) {
      try {
        const row = await diskCacheGet(k);
        if (row) {
          memorySet(k, row);
          stats.hits++;
          stats.diskHits++;
          return { ...row, hitKey: k };
        }
      } catch (e) {
        console.warn('[GeoPas cache] Disk get failed:', e.message);
      }
    }
  }

  stats.misses++;
  return null;
}

export async function setGeopasCacheEntry(key, data, ttlSeconds, meta = {}) {
  const cfg = cacheConfig();
  if (!cfg.enabled || !key) return;

  const ttl = ttlSeconds ?? cfg.ttlSeconds;
  const entry = {
    data,
    cachedAt: Date.now(),
    expiresAt: Date.now() + ttl * 1000,
  };

  memorySet(key, entry);
  stats.writes++;

  if (cfg.useSupabase) {
    try {
      await supabaseSet(key, entry, meta, cfg);
    } catch (e) {
      console.warn('[GeoPas cache] Supabase set failed:', e.message);
    }
  }

  if (diskCacheEnabled()) {
    try {
      const ok = await diskCacheSet(key, entry, meta);
      if (ok) stats.diskWrites++;
    } catch (e) {
      console.warn('[GeoPas cache] Disk set failed:', e.message);
    }
  }
}

export async function invalidateGeopasCache(key) {
  memoryDelete(key);
  const cfg = cacheConfig();
  if (cfg.useSupabase) {
    try {
      await fetch(`${cfg.supabaseUrl}/rest/v1/geopas_analysis_cache?cache_key=eq.${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: supabaseHeaders(cfg.serviceKey),
      });
    } catch (e) {
      console.warn('[GeoPas cache] Supabase delete failed:', e.message);
    }
  }
}

const SEARCH_PREFIX = 'search_';

/** Kompletní analýza + surová GeoPas data (katastr, záplavy, LV, …). */
export async function storePropertyAnalysisCache(query, analysis, geopasRaw, ttlSeconds) {
  const cfg = cacheConfig();
  if (!cfg.enabled) return;

  const queryKey = normalizeCacheKey(query);
  const payload = wrapCachePayload(analysis, geopasRaw);
  const meta = {
    query,
    parcelId: analysis.parcelId,
    address: analysis.address,
  };

  await setGeopasCacheEntry(queryKey, payload, ttlSeconds, meta);

  const pKey = parcelCacheKey(analysis.parcelId);
  if (pKey && pKey !== queryKey) {
    await setGeopasCacheEntry(pKey, payload, ttlSeconds, meta);
  }

  if (analysis.address) {
    const addrKey = normalizeCacheKey(analysis.address);
    if (addrKey && addrKey !== queryKey && addrKey !== pKey) {
      await setGeopasCacheEntry(addrKey, payload, ttlSeconds, meta);
    }
  }
}

/** Načte analýzu / surová data — klíče: dotaz, parcela, adresa. */
export async function loadPropertyAnalysisCache(query, resultHint = {}) {
  const cfg = cacheConfig();
  if (!cfg.enabled) return null;

  const queryKey = normalizeCacheKey(query);
  const aliasKeys = [];
  const pKey = parcelCacheKey(resultHint.parcelId);
  if (pKey) aliasKeys.push(pKey);

  const entry = await getGeopasCacheEntry(queryKey, { aliasKeys });
  if (!entry) return null;

  const { analysis, geopasRaw } = unwrapCachePayload(entry.data);
  return {
    ...entry,
    analysis,
    geopasRaw,
  };
}

/** Cache našeptávače entityByTerm — kratší TTL. */
export async function loadSearchCache(query) {
  const key = SEARCH_PREFIX + normalizeCacheKey(query);
  const entry = await getGeopasCacheEntry(key);
  if (!entry) return null;
  return entry.data?.results ?? null;
}

export async function storeSearchCache(query, results) {
  const cfg = cacheConfig();
  if (!cfg.enabled) return;
  const key = SEARCH_PREFIX + normalizeCacheKey(query);
  await setGeopasCacheEntry(key, { results }, cfg.searchTtlSeconds, { query });
}

export function getGeopasCacheStats() {
  const cfg = cacheConfig();
  let valid = 0;
  let expired = 0;
  const now = Date.now();
  memory.forEach((entry) => {
    if (now > entry.expiresAt) expired++;
    else valid++;
  });
  return {
    enabled: cfg.enabled,
    backend: cfg.backend,
    supabase: cfg.useSupabase,
    disk: diskCacheEnabled(),
    ttlHours: cfg.ttlHours,
    searchTtlHours: cfg.searchTtlSeconds / 3600,
    memory: { valid, expired, total: memory.size },
    counters: { ...stats },
  };
}

export async function getGeopasCacheStatsAsync() {
  const base = getGeopasCacheStats();
  const disk = await diskCacheStats();
  return { ...base, diskDetail: disk };
}

export function resetGeopasCacheStats() {
  stats = { hits: 0, misses: 0, writes: 0 };
}
