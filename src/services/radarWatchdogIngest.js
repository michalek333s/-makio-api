/**
 * Radar Watchdog ingest — upsert listing + price_history + alert matches.
 * Volá webhook z Apify nebo interní enrich-pull.
 */

import {
  appendPriceHistory,
  buildRadarContentHash,
  detectPrivateSeller,
  mapDealType,
  mapPropertyType,
} from '../lib/radarContentHash.js';
import { canonicalizeSourceUrl, finishNormalizedListing } from '../lib/radarNormalize.js';
import { listingMatchesAlert } from './radarAlertMatch.js';
import { normalizeSrealityApifyListing } from './srealityApify.js';

function cfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return {
    enabled: Boolean(supabaseUrl && serviceKey),
    supabaseUrl,
    serviceKey,
  };
}

function headers(serviceKey, extra = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...extra,
  };
}

async function sb(path, options, c) {
  try {
    return await fetch(`${c.supabaseUrl}/rest/v1/${path}`, {
      ...options,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.warn('[Radar Watchdog]', e.message);
    return null;
  }
}

function normalizeIncoming(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') return null;

  let listing = raw;
  if (raw.adId || raw.hash_id || raw.usableArea != null) {
    listing = normalizeSrealityApifyListing(raw) || raw;
  }
  listing = finishNormalizedListing(listing) || listing;

  const url = canonicalizeSourceUrl(listing.url || listing.source_url || raw.url);
  if (!url) return null;

  const price = listing.price != null ? Number(listing.price) : null;
  const floorArea = listing.floorArea ?? listing.floor_area ?? null;
  const isPrivate = detectPrivateSeller(listing);

  const content_hash = buildRadarContentHash({
    locality: listing.locality,
    city: listing.city,
    floorArea,
    price,
    layout: listing.layout,
  });

  return {
    source: String(listing.source || meta.source || 'sreality').slice(0, 50),
    source_url: url,
    listing_external_id: String(listing.listingId || listing.listing_external_id || raw.adId || '').slice(0, 120) || null,
    title: listing.title || null,
    description: listing.description || null,
    price: Number.isFinite(price) ? price : null,
    floor_area: floorArea != null && Number.isFinite(Number(floorArea)) ? Number(floorArea) : null,
    layout: listing.layout || null,
    locality: typeof listing.locality === 'string' ? listing.locality : listing.city || null,
    city: listing.city || null,
    region: listing.region || meta.region || null,
    phone_e164: listing.phone || listing.phone_e164 || null,
    lat: listing.lat ?? null,
    lng: listing.lng ?? null,
    thumbnail_url: listing.imageUrl || listing.thumbnail_url || (listing.imageUrls && listing.imageUrls[0]) || null,
    image_urls: Array.isArray(listing.imageUrls) ? listing.imageUrls.slice(0, 12) : [],
    deal_type: mapDealType(listing.offerType || listing.deal_type || meta.offerType),
    property_type: mapPropertyType(listing.propertyType || listing.property_type || meta.propertyType),
    content_hash,
    is_private_seller: isPrivate,
    location_district: listing.district || listing.location_district || null,
    status: isPrivate ? 'NEW_PRIVATE' : listing.radarStatus || 'SUSPECTED_BROKER',
    reasons: Array.isArray(listing.reasons) ? listing.reasons : [],
    payload: {
      source: listing.source,
      scrapedVia: 'apify_webhook',
      region: listing.region || meta.region || null,
    },
    scraped_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function fetchExistingByUrl(url, c) {
  const q =
    `radar_listings?source_url=eq.${encodeURIComponent(url)}` +
    `&select=id,price,price_history,content_hash&limit=1`;
  const res = await sb(q, { headers: headers(c.serviceKey) }, c);
  if (!res?.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows?.[0] || null;
}

async function upsertListing(row, c) {
  const existing = await fetchExistingByUrl(row.source_url, c);
  let price_history = [];
  let last_price_drop = null;
  let last_price_drop_at = null;

  if (existing) {
    const hist = appendPriceHistory(existing.price, row.price, existing.price_history);
    price_history = hist.history;
    if (hist.dropped != null) {
      last_price_drop = hist.dropped;
      last_price_drop_at = new Date().toISOString();
    }
  } else if (row.price != null) {
    price_history = [{ price: row.price, at: new Date().toISOString(), delta: 0 }];
  }

  const body = {
    ...row,
    price_history,
    last_price_drop,
    last_price_drop_at,
  };

  const res = await sb(
    'radar_listings?on_conflict=source_url',
    {
      method: 'POST',
      headers: {
        ...headers(c.serviceKey),
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(body),
    },
    c,
  );

  if (!res?.ok) {
    const text = await res?.text().catch(() => '');
    console.warn('[Radar Watchdog] upsert', res?.status, text.slice(0, 200));
    return { listing: null, priceDropped: last_price_drop };
  }

  const rows = await res.json().catch(() => []);
  const listing = Array.isArray(rows) ? rows[0] : rows;
  return {
    listing: listing
      ? { ...listing, last_price_drop: last_price_drop ?? listing.last_price_drop }
      : null,
    priceDropped: last_price_drop,
    isNew: !existing,
  };
}

async function loadActiveAlerts(c) {
  const res = await sb(
    'radar_alerts?is_active=eq.true&select=*',
    { headers: headers(c.serviceKey) },
    c,
  );
  if (!res?.ok) return [];
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function createMatch(alert, listing, matchMeta, c) {
  const body = {
    alert_id: alert.id,
    listing_id: listing.id,
    user_id: alert.user_id,
    match_reason: matchMeta.reason || 'match',
    is_priority: Boolean(matchMeta.priority),
    content_hash: listing.content_hash || null,
    is_read: false,
  };

  const res = await sb(
    'radar_matches?on_conflict=alert_id,listing_id',
    {
      method: 'POST',
      headers: {
        ...headers(c.serviceKey),
        Prefer: 'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify(body),
    },
    c,
  );

  if (!res?.ok) {
    // unique content_hash per alert — ignore duplicate
    return null;
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : rows;
}

/**
 * Pošle e-mail přes Resend, pokud je RESEND_API_KEY + kanál email.
 * Bez klíče jen log (produkce fail-soft).
 */
async function dispatchEmailNotification({ alert, listing, match }) {
  const channels = alert.notification_channels || [];
  if (!channels.includes('email')) return { sent: false, reason: 'no_email_channel' };

  const key = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.RESEND_FROM || 'Makio Radar <radar@makio.cz>').trim();
  if (!key) {
    console.log(
      `[Radar Watchdog] email skip (no RESEND_API_KEY): alert=${alert.alert_name} listing=${listing.title}`,
    );
    return { sent: false, reason: 'no_resend_key' };
  }

  // E-mail: 1) alert.notify_email 2) Auth Admin user 3) profiles.email (pokud sloupec existuje)
  const c = cfg();
  let to = String(alert.notify_email || '').trim() || null;

  if (!to && c.enabled) {
    try {
      const authRes = await fetch(
        `${c.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(alert.user_id)}`,
        {
          headers: {
            apikey: c.serviceKey,
            Authorization: `Bearer ${c.serviceKey}`,
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (authRes.ok) {
        const user = await authRes.json().catch(() => null);
        to = user?.email || user?.user?.email || null;
      }
    } catch (e) {
      console.warn('[Radar Watchdog] auth email lookup:', e.message);
    }
  }

  if (!to && c.enabled) {
    const res = await sb(
      `profiles?id=eq.${encodeURIComponent(alert.user_id)}&select=*`,
      { headers: headers(c.serviceKey) },
      c,
    );
    if (res?.ok) {
      const rows = await res.json().catch(() => []);
      const row = rows?.[0];
      to = row?.email || row?.contact_email || null;
    }
  }
  if (!to) return { sent: false, reason: 'no_user_email' };

  const drop = listing.last_price_drop;
  const subject = match?.is_priority
    ? `Sleva nemovitosti: ${listing.title || 'inzerát'}`
    : `Radar: ${listing.title || 'nový inzerát'}`;

  const html = `
    <p><strong>${match?.match_reason || 'Nový inzerát'}</strong></p>
    <p>${listing.title || ''}</p>
    <p>${listing.locality || ''} · ${listing.price ? `${Number(listing.price).toLocaleString('cs-CZ')} Kč` : ''}</p>
    ${drop ? `<p style="color:#c2410c">Sleva ${Number(drop).toLocaleString('cs-CZ')} Kč</p>` : ''}
    <p><a href="${listing.source_url}">Otevřít inzerát</a></p>
    <p style="color:#888;font-size:12px">Hlídací pes: ${alert.alert_name}</p>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.warn('[Radar Watchdog] Resend', res.status, await res.text().catch(() => ''));
      return { sent: false, reason: 'resend_error' };
    }
    return { sent: true };
  } catch (e) {
    console.warn('[Radar Watchdog] Resend fail', e.message);
    return { sent: false, reason: e.message };
  }
}

/**
 * @param {Array<object>} items — raw Apify dataset items
 * @param {{ region?: string, propertyType?: string, offerType?: string, source?: string }} meta
 */
export async function ingestRadarWebhookItems(items, meta = {}) {
  const c = cfg();
  if (!c.enabled) {
    return { ok: false, error: 'Supabase service_role není nastaven.', stored: 0, matches: 0 };
  }

  const list = Array.isArray(items) ? items : [];
  const alerts = await loadActiveAlerts(c);
  let stored = 0;
  let matches = 0;
  let priceDrops = 0;
  const errors = [];

  for (const raw of list.slice(0, 500)) {
    try {
      const row = normalizeIncoming(raw, meta);
      if (!row) continue;

      const { listing, priceDropped, isNew } = await upsertListing(row, c);
      if (!listing?.id) continue;
      stored += 1;
      if (priceDropped) priceDrops += 1;

      // Matching jen pro nové nebo slevu (delta)
      if (!isNew && !priceDropped) continue;

      for (const alert of alerts) {
        const hit = listingMatchesAlert(listing, alert);
        if (!hit.ok) continue;
        const match = await createMatch(alert, listing, hit, c);
        if (match?.id) {
          matches += 1;
          await dispatchEmailNotification({ alert, listing, match });
        }
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  return {
    ok: true,
    stored,
    matches,
    priceDrops,
    alertCount: alerts.length,
    errors: errors.slice(0, 5),
  };
}

export { normalizeIncoming, buildRadarContentHash };
