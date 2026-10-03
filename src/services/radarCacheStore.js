import { loadDiskListings, persistDiskListings } from './radarDiskCache.js';
import {
  isDemoListing,
  isRadarDemoFallbackEnabled,
  stripDemoListings,
} from '../data/radarDemoListings.js';
import { filterListingsByRegion } from '../lib/radarRegions.js';
import { invalidateRadarScanMemory } from './radarScanMemory.js';

const memory = new Map();
const scanMemory = new Map();

function config() {
  const ttlHours = Number(process.env.RADAR_CACHE_TTL_HOURS || 12);
  const scanTtlHours = Number(process.env.RADAR_SCAN_CACHE_TTL_HOURS || 1);
  const ttlSeconds = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours * 3600 : 12 * 3600;
  const scanTtlSeconds =
    Number.isFinite(scanTtlHours) && scanTtlHours > 0 ? scanTtlHours * 3600 : 3600;
  const enabled = process.env.RADAR_CACHE_ENABLED !== '0';
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const useSupabase = enabled && Boolean(supabaseUrl && serviceKey);
  const minListingsForSkipLive = Number(process.env.RADAR_CACHE_MIN_LISTINGS || 3);
  return {
    enabled,
    ttlSeconds,
    scanTtlSeconds,
    useSupabase,
    supabaseUrl,
    serviceKey,
    ttlHours,
    scanTtlHours,
    minListingsForSkipLive,
  };
}

function headers(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

/** Region-scoped key — zabrání přepisu stejného listingId mezi kraji. */
function listingKey(listing, region) {
  const r = String(region || listing?.region || 'unknown').trim();
  return `${r}::${listing.source || 'unknown'}:${listing.listingId}`;
}

function regionKey(region, propertyType) {
  return `${String(region).trim()}::${String(propertyType || 'byty').trim()}`;
}

async function supabaseFetch(url, options, cfg) {
  try {
    return await fetch(url, {
      ...options,
      signal: options?.signal || AbortSignal.timeout(12_000),
    });
  } catch (e) {
    console.warn('[Radar cache] Supabase nedostupné:', e.message);
    return null;
  }
}

function rebuildRegionIndex(rk, keys, expiresAt) {
  memory.set(`__index__:${rk}`, {
    keys: [...keys],
    cachedAt: Date.now(),
    expiresAt,
  });
}

export async function storeRadarListings(listings, { region, propertyType } = {}) {
  const cfg = config();
  const allowDemo = isRadarDemoFallbackEnabled();
  const stamped = (Array.isArray(listings) ? listings : [])
    .filter((l) => allowDemo || !isDemoListing(l))
    .map((l) => ({ ...l, region: region || l.region || null }));
  const clean = filterListingsByRegion(stamped, region);
  if (!cfg.enabled || clean.length === 0) return 0;

  const now = Date.now();
  const expiresAt = new Date(now + cfg.ttlSeconds * 1000).toISOString();
  const rk = regionKey(region, propertyType);
  const indexKeys = new Set(memory.get(`__index__:${rk}`)?.keys || []);
  let stored = 0;

  for (const listing of clean) {
    const key = listingKey(listing, region);
    memory.set(key, {
      data: listing,
      cachedAt: now,
      expiresAt: now + cfg.ttlSeconds * 1000,
      regionKey: rk,
    });
    indexKeys.add(key);
    stored++;
  }

  rebuildRegionIndex(rk, indexKeys, now + cfg.ttlSeconds * 1000);

  if (cfg.useSupabase) {
    const rows = clean.map((listing) => ({
      cache_key: listingKey(listing, region),
      region: region || null,
      property_type: propertyType || null,
      source: listing.source || null,
      listing_id: String(listing.listingId || ''),
      payload: listing,
      scraped_at: listing.scrapedAt || new Date(now).toISOString(),
      expires_at: expiresAt,
    }));

    const chunkSize = 50;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const res = await supabaseFetch(
        `${cfg.supabaseUrl}/rest/v1/radar_listing_cache?on_conflict=cache_key`,
        {
          method: 'POST',
          headers: { ...headers(cfg.serviceKey), Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(chunk),
        },
        cfg,
      );
      if (res && !res.ok) {
        console.warn('[Radar cache] Supabase write:', res.status, await res.text().catch(() => ''));
      }
    }
  }

  console.log(`[Radar cache] Uloženo ${stored} inzerátů (${region}/${propertyType})`);
  persistDiskListings(clean, { region, propertyType });
  if (stored > 0) {
    invalidateRadarScanMemory(region, propertyType);
    clearScanMemoryForRegion(region, propertyType);
  }
  return stored;
}

function clearScanMemoryForRegion(region, propertyType) {
  const r = String(region || '');
  const p = String(propertyType || '');
  for (const key of [...scanMemory.keys()]) {
    if ((!r || key.includes(r)) && (!p || key.includes(p))) {
      scanMemory.delete(key);
    }
  }
}

export async function loadRadarListingsForScan(region, propertyType) {
  const cfg = config();
  const rk = regionKey(region, propertyType);
  const idx = memory.get(`__index__:${rk}`);
  const out = [];
  const seen = new Set();

  if (idx && Date.now() < idx.expiresAt) {
    for (const key of idx.keys || []) {
      const row = memory.get(key);
      if (row && Date.now() < row.expiresAt && row.data) {
        out.push(row.data);
        seen.add(key);
      }
    }
  }

  if (cfg.useSupabase) {
    const now = new Date().toISOString();
    const url =
      `${cfg.supabaseUrl}/rest/v1/radar_listing_cache` +
      `?region=eq.${encodeURIComponent(region)}` +
      `&property_type=eq.${encodeURIComponent(propertyType)}` +
      `&expires_at=gt.${encodeURIComponent(now)}` +
      `&select=cache_key,payload,scraped_at` +
      `&order=scraped_at.desc` +
      `&limit=800`;

    const res = await supabaseFetch(url, { headers: headers(cfg.serviceKey) }, cfg);
    if (res?.ok) {
      const rows = await res.json();
      const loadedKeys = new Set(seen);
      for (const row of rows || []) {
        if (!row?.payload || seen.has(row.cache_key)) continue;
        out.push(row.payload);
        seen.add(row.cache_key);
        loadedKeys.add(row.cache_key);
        memory.set(row.cache_key, {
          data: row.payload,
          cachedAt: Date.parse(row.scraped_at) || Date.now(),
          expiresAt: Date.parse(now) + cfg.ttlSeconds * 1000,
          regionKey: rk,
        });
      }
      if (loadedKeys.size > 0) {
        rebuildRegionIndex(rk, loadedKeys, Date.now() + cfg.ttlSeconds * 1000);
      }
    } else if (res) {
      console.warn('[Radar cache] Supabase read:', res.status, await res.text().catch(() => ''));
    }
  }

  if (out.length === 0) {
    const disk = loadDiskListings(region, propertyType);
    if (disk.length > 0) {
      const loadedKeys = new Set();
      for (const listing of disk) {
        const key = listingKey(listing, region);
        if (seen.has(key)) continue;
        out.push(listing);
        seen.add(key);
        loadedKeys.add(key);
        memory.set(key, {
          data: listing,
          cachedAt: Date.now(),
          expiresAt: Date.now() + cfg.ttlSeconds * 1000,
          regionKey: rk,
        });
      }
      if (loadedKeys.size > 0) {
        rebuildRegionIndex(rk, loadedKeys, Date.now() + cfg.ttlSeconds * 1000);
        console.log(`[Radar cache] Disk: ${disk.length} inzerátů (${region}/${propertyType})`);
      }
    }
  }

  return stripDemoListings(filterListingsByRegion(out, region));
}

/**
 * Rozhodnutí, zda přeskočit přímé Sreality API.
 * Default = SKIP: z datacenter IP endpoint vrací 404 (blokace), data jdou přes Apify/cache.
 * Live zapněte jen RADAR_SREALITY_DIRECT=1 (a obvykle RADAR_CACHE_ONLY=0).
 */
export function shouldSkipLiveSreality(cachedCount) {
  // Explicitní opt-in na přímé API
  if (process.env.RADAR_SREALITY_DIRECT === '1') {
    const cfg = config();
    if (process.env.RADAR_CACHE_ONLY !== '0' && cachedCount >= cfg.minListingsForSkipLive) {
      return true;
    }
    return false;
  }
  // RADAR_SKIP_LIVE_SREALITY=0 + CACHE_ONLY=0 = starý režim „zkus live když je cache slabá“
  if (process.env.RADAR_SKIP_LIVE_SREALITY === '0' && process.env.RADAR_CACHE_ONLY === '0') {
    const cfg = config();
    if (!cachedCount || cachedCount === 0) return false;
    return cachedCount >= cfg.minListingsForSkipLive;
  }
  // Výchozí: nikdy nevolej přímé Sreality (i při prázdné cache)
  return true;
}

/** Metadata cache pro region — rozhodnutí o background refresh. */
export async function getListingCacheMeta(region, propertyType) {
  const cfg = config();
  const rk = regionKey(region, propertyType);
  let count = 0;
  let newestAt = null;

  const idx = memory.get(`__index__:${rk}`);
  if (idx && Date.now() < idx.expiresAt) {
    for (const key of idx.keys || []) {
      const row = memory.get(key);
      if (row && Date.now() < row.expiresAt && row.data) {
        count++;
        if (row.cachedAt && (!newestAt || row.cachedAt > newestAt)) newestAt = row.cachedAt;
      }
    }
  }

  if (cfg.useSupabase) {
    const now = new Date().toISOString();
    const url =
      `${cfg.supabaseUrl}/rest/v1/radar_listing_cache` +
      `?region=eq.${encodeURIComponent(region)}` +
      `&property_type=eq.${encodeURIComponent(propertyType)}` +
      `&expires_at=gt.${encodeURIComponent(now)}` +
      `&select=scraped_at` +
      `&order=scraped_at.desc` +
      `&limit=800`;

    const res = await supabaseFetch(url, { headers: headers(cfg.serviceKey) }, cfg);
    if (res?.ok) {
      const rows = await res.json();
      const sbCount = rows?.length || 0;
      if (sbCount > count) count = sbCount;
      const sbNewest = rows?.[0]?.scraped_at ? Date.parse(rows[0].scraped_at) : null;
      if (sbNewest && (!newestAt || sbNewest > newestAt)) newestAt = sbNewest;
    }
  }

  const ageMs = newestAt ? Date.now() - newestAt : null;
  return {
    region,
    propertyType,
    count,
    newestAt: newestAt ? new Date(newestAt).toISOString() : null,
    ageMs,
    ageMin: ageMs != null ? Math.round(ageMs / 60_000) : null,
    supabase: cfg.useSupabase,
  };
}

export async function storeScanResult(cacheKey, data, { region, propertyType } = {}) {
  const cfg = config();
  const now = Date.now();
  const entry = {
    data,
    cachedAt: now,
    expiresAt: now + cfg.scanTtlSeconds * 1000,
  };
  scanMemory.set(cacheKey, entry);

  if (!cfg.useSupabase) return;

  const body = {
    cache_key: cacheKey,
    region: region || null,
    property_type: propertyType || null,
    payload: data,
    cached_at: new Date(now).toISOString(),
    expires_at: new Date(entry.expiresAt).toISOString(),
  };

  const res = await supabaseFetch(
    `${cfg.supabaseUrl}/rest/v1/radar_scan_cache?on_conflict=cache_key`,
    {
      method: 'POST',
      headers: { ...headers(cfg.serviceKey), Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(body),
    },
    cfg,
  );
  if (res && !res.ok) {
    console.warn('[Radar scan cache] write:', res.status, await res.text().catch(() => ''));
  }
}

export async function loadScanResult(cacheKey) {
  const cfg = config();
  const mem = scanMemory.get(cacheKey);
  if (mem && Date.now() < mem.expiresAt) {
    return { ...mem.data, fromCache: true, cacheLayer: 'memory' };
  }

  if (!cfg.useSupabase) return null;

  const now = new Date().toISOString();
  const url =
    `${cfg.supabaseUrl}/rest/v1/radar_scan_cache` +
    `?cache_key=eq.${encodeURIComponent(cacheKey)}` +
    `&expires_at=gt.${encodeURIComponent(now)}` +
    `&select=payload,cached_at` +
    `&limit=1`;

  const res = await supabaseFetch(url, { headers: headers(cfg.serviceKey) }, cfg);
  if (!res?.ok) return null;

  const rows = await res.json();
  const row = rows?.[0];
  if (!row?.payload) return null;

  const cachedAt = Date.parse(row.cached_at) || Date.now();
  scanMemory.set(cacheKey, {
    data: row.payload,
    cachedAt,
    expiresAt: cachedAt + cfg.scanTtlSeconds * 1000,
  });

  return {
    ...row.payload,
    fromCache: true,
    cacheLayer: 'supabase',
    cacheAgeMin: Math.round((Date.now() - cachedAt) / 60_000),
  };
}

export function getRadarCacheStats() {
  const cfg = config();
  let valid = 0;
  let expired = 0;
  for (const [k, v] of memory) {
    if (k.startsWith('__index__')) continue;
    if (Date.now() < v.expiresAt) valid++;
    else expired++;
  }
  let scanValid = 0;
  for (const [, v] of scanMemory) {
    if (Date.now() < v.expiresAt) scanValid++;
  }
  return {
    enabled: cfg.enabled,
    ttlHours: cfg.ttlHours,
    scanTtlHours: cfg.scanTtlHours,
    supabase: cfg.useSupabase,
    minListingsForSkipLive: cfg.minListingsForSkipLive,
    memory: { listings: { valid, expired }, scans: scanValid },
  };
}
