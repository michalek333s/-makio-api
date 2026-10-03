/**
 * Radar v2 pool v Supabase — radar_listings, reference_agency_listings, broker_blacklist.
 * Zápis jen service_role. Chybějící tabulka / timeout = warning, scan nespadne.
 */

import { isDemoListing } from '../data/radarDemoListings.js';
import { canonicalizeSourceUrl } from '../lib/radarNormalize.js';
import { RADAR_STATUS } from './radarValidate.js';
import { addToMemoryBlacklist, listingsToIngestShape, seedMemoryBlacklist } from './radarIngest.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STATUSES = new Set(Object.values(RADAR_STATUS));

function config() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return {
    enabled: process.env.RADAR_V2_PERSIST !== '0' && Boolean(supabaseUrl && serviceKey),
    supabaseUrl,
    serviceKey,
  };
}

function headers(serviceKey, extra = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function sbFetch(url, options, cfg) {
  try {
    return await fetch(url, {
      ...options,
      signal: options?.signal || AbortSignal.timeout(12_000),
    });
  } catch (e) {
    console.warn('[Radar v2] Supabase:', e.message);
    return null;
  }
}

export function isRadarUuid(value) {
  return UUID_RE.test(String(value || ''));
}

function asTextArray(value, max = 12) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const s = String(item || '').trim();
    if (!s) continue;
    out.push(s.slice(0, 2000));
    if (out.length >= max) break;
  }
  return out;
}

export function slimRadarPayload(listing) {
  if (!listing || typeof listing !== 'object') return {};
  const { _raw, payload, ...rest } = listing;
  return rest;
}

/** Vyhodí řádek bez URL / bez statusu — DB check + unique source_url. */
export function sanitizePrivateRow(row) {
  if (!row) return null;
  const source_url = canonicalizeSourceUrl(row.source_url);
  if (!source_url) return null;
  if (!STATUSES.has(row.status)) return null;
  const matched = isRadarUuid(row.matched_agency_listing_id) ? row.matched_agency_listing_id : null;
  return {
    source: String(row.source || 'unknown').slice(0, 50),
    source_url,
    listing_external_id: row.listing_external_id ? String(row.listing_external_id).slice(0, 120) : null,
    title: row.title || null,
    description: row.description || null,
    price: row.price ?? null,
    floor_area: row.floor_area ?? null,
    layout: row.layout || null,
    locality: row.locality || null,
    city: row.city || null,
    region: row.region || null,
    phone_e164: row.phone_e164 || null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    photo_phash: row.photo_phash || (asTextArray(row.image_hashes, 1)[0] || null),
    image_urls: asTextArray(row.image_urls, 12),
    image_hashes: asTextArray(row.image_hashes, 8),
    contact_name: row.contact_name ? String(row.contact_name).slice(0, 100) : null,
    currency: row.currency ? String(row.currency).slice(0, 3) : 'CZK',
    status: row.status,
    match_confidence: row.match_confidence ?? null,
    matched_agency_listing_id: matched,
    matched_agency_url: row.matched_agency_url || null,
    reasons: Array.isArray(row.reasons) ? row.reasons : [],
    payload: slimRadarPayload(row.payload),
    scraped_at: row.scraped_at || new Date().toISOString(),
    validated_at: row.validated_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function sanitizeReferenceRow(row) {
  if (!row) return null;
  const source_url = canonicalizeSourceUrl(row.source_url);
  if (!source_url) return null;
  return {
    source: String(row.source || 'unknown').slice(0, 50),
    source_url,
    listing_external_id: row.listing_external_id ? String(row.listing_external_id).slice(0, 120) : null,
    title: row.title || null,
    price: row.price ?? null,
    floor_area: row.floor_area ?? null,
    layout: row.layout || null,
    locality: row.locality || null,
    city: row.city || null,
    region: row.region || null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    photo_phash: row.photo_phash || (asTextArray(row.image_hashes, 1)[0] || null),
    image_urls: asTextArray(row.image_urls, 12),
    image_hashes: asTextArray(row.image_hashes, 8),
    agency_name: row.agency_name || null,
    payload: slimRadarPayload(row.payload),
    scraped_at: row.scraped_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function chunk(arr, size = 40) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function upsertTable(table, rows, conflict, cfg) {
  if (!rows.length) return [];
  const saved = [];
  const v21Cols = ['image_urls', 'image_hashes', 'contact_name', 'currency'];
  for (const part of chunk(rows)) {
    let payload = part;
    const res = await sbFetch(
      `${cfg.supabaseUrl}/rest/v1/${table}?on_conflict=${conflict}`,
      {
        method: 'POST',
        headers: headers(cfg.serviceKey, {
          Prefer: 'return=representation,resolution=merge-duplicates',
        }),
        body: JSON.stringify(payload),
      },
      cfg,
    );
    if (!res) continue;
    let text = await res.text().catch(() => '');
    if (!res.ok && /image_urls|image_hashes|contact_name|currency|PGRST204/i.test(text)) {
      payload = part.map((row) => {
        const copy = { ...row };
        for (const k of v21Cols) delete copy[k];
        return copy;
      });
      const retry = await sbFetch(
        `${cfg.supabaseUrl}/rest/v1/${table}?on_conflict=${conflict}`,
        {
          method: 'POST',
          headers: headers(cfg.serviceKey, {
            Prefer: 'return=representation,resolution=merge-duplicates',
          }),
          body: JSON.stringify(payload),
        },
        cfg,
      );
      if (retry) {
        text = await retry.text().catch(() => '');
        if (retry.ok) {
          try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) saved.push(...parsed);
          } catch {
            /* ignore */
          }
          continue;
        }
      }
      console.warn(`[Radar v2] ${table} write ${retry?.status || res.status}:`, text.slice(0, 280));
      continue;
    }
    if (!res.ok) {
      console.warn(`[Radar v2] ${table} write ${res.status}:`, text.slice(0, 280));
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) saved.push(...parsed);
    } catch {
      /* ignore */
    }
  }
  return saved;
}

function referenceAsListing(row) {
  return {
    listingId: row.id,
    id: row.id,
    source: row.source,
    url: row.source_url,
    sourceUrl: row.source_url,
    title: row.title,
    price: row.price != null ? Number(row.price) : null,
    floorArea: row.floor_area != null ? Number(row.floor_area) : null,
    layout: row.layout,
    locality: row.locality,
    city: row.city,
    region: row.region,
    lat: row.lat != null ? Number(row.lat) : null,
    lon: row.lng != null ? Number(row.lng) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    photoPHash: row.photo_phash,
    imageHashes: Array.isArray(row.image_hashes) ? row.image_hashes : [],
    imageUrls: Array.isArray(row.image_urls) ? row.image_urls : [],
    agencyName: row.agency_name,
    isAgencyListing: true,
  };
}

export async function loadAgencyReferencesForMatch({ region, limit = 250 } = {}) {
  const cfg = config();
  if (!cfg.enabled) return [];
  const selectFull =
    'id,source,source_url,title,price,floor_area,layout,locality,city,region,lat,lng,photo_phash,image_urls,image_hashes,agency_name';
  const selectBase =
    'id,source,source_url,title,price,floor_area,layout,locality,city,region,lat,lng,photo_phash,agency_name';
  const buildUrl = (select) => {
    const qs = new URLSearchParams({
      select,
      order: 'scraped_at.desc',
      limit: String(Math.min(500, Math.max(20, limit))),
    });
    if (region) qs.set('region', `eq.${region}`);
    return `${cfg.supabaseUrl}/rest/v1/reference_agency_listings?${qs.toString()}`;
  };
  let res = await sbFetch(buildUrl(selectFull), { method: 'GET', headers: headers(cfg.serviceKey) }, cfg);
  if (res && !res.ok) {
    res = await sbFetch(buildUrl(selectBase), { method: 'GET', headers: headers(cfg.serviceKey) }, cfg);
  }
  if (!res || !res.ok) return [];
  const rows = await res.json().catch(() => []);
  return (Array.isArray(rows) ? rows : []).map(referenceAsListing);
}

export async function loadBrokerBlacklistPhones({ limit = 4000 } = {}) {
  const cfg = config();
  if (!cfg.enabled) return [];
  const url =
    `${cfg.supabaseUrl}/rest/v1/broker_blacklist` +
    `?select=phone_e164&limit=${encodeURIComponent(limit)}`;
  const res = await sbFetch(url, { method: 'GET', headers: headers(cfg.serviceKey) }, cfg);
  if (!res || !res.ok) return [];
  const rows = await res.json().catch(() => []);
  return (Array.isArray(rows) ? rows : []).map((r) => r.phone_e164).filter(Boolean);
}

export async function hydrateRadarV2FromSupabase() {
  const phones = await loadBrokerBlacklistPhones();
  if (phones.length) seedMemoryBlacklist(phones);
  return { blacklist: phones.length };
}

/**
 * Upsert z výstupu ingestRadarBatch. Přeskočí demo a řádky bez URL.
 */
export async function persistRadarV2Ingest(ingested, { region } = {}) {
  const cfg = config();
  const empty = { enabled: cfg.enabled, references: 0, listings: 0, blacklist: 0 };
  if (!cfg.enabled || !Array.isArray(ingested) || ingested.length === 0) return empty;

  const refs = [];
  const privates = [];
  const blacklist = [];

  for (const item of ingested) {
    const listing = item?.listing;
    if (isDemoListing(listing)) continue;
    if (item.referenceRow) {
      const row = sanitizeReferenceRow({
        ...item.referenceRow,
        region: item.referenceRow.region || region || null,
      });
      if (row) refs.push(row);
    }
    if (item.privateRow) {
      const row = sanitizePrivateRow({
        ...item.privateRow,
        region: item.privateRow.region || region || null,
      });
      if (row) privates.push(row);
    }
    const bl = item.validation?.autoBlacklist;
    if (bl?.phone) {
      addToMemoryBlacklist(bl.phone, bl.reason);
      blacklist.push({
        phone_e164: bl.phone,
        reason: bl.reason || 'auto',
        source: listing?.source || 'radar',
        last_seen_at: new Date().toISOString(),
      });
    }
  }

  const savedRefs = await upsertTable('reference_agency_listings', refs, 'source_url', cfg);
  const urlToId = new Map(savedRefs.filter((r) => r.source_url && r.id).map((r) => [r.source_url, r.id]));

  const privatesWithFk = privates.map((row) => {
    if (row.matched_agency_listing_id) return row;
    const url = canonicalizeSourceUrl(row.matched_agency_url);
    const id = url ? urlToId.get(url) : null;
    return id ? { ...row, matched_agency_listing_id: id } : row;
  });

  const savedPriv = await upsertTable('radar_listings', privatesWithFk, 'source_url', cfg);
  const savedBl = await upsertTable('broker_blacklist', blacklist, 'phone_e164', cfg);

  if (savedRefs.length || savedPriv.length || savedBl.length) {
    console.log(
      `[Radar v2] persist: RK ${savedRefs.length}/${refs.length}, ` +
        `soukromé ${savedPriv.length}/${privates.length}, blacklist ${savedBl.length} (${region || '—'})`,
    );
  }

  return {
    enabled: true,
    references: savedRefs.length,
    listings: savedPriv.length,
    blacklist: savedBl.length,
  };
}

export async function persistValidatedListings(listings, { region } = {}) {
  return persistRadarV2Ingest(listingsToIngestShape(listings), { region });
}
