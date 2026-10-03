/**
 * CRUD hlídacích psů + matches feed.
 */

import { Router } from 'express';

const router = Router();

function cfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return { enabled: Boolean(supabaseUrl && serviceKey), supabaseUrl, serviceKey };
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

function userId(req) {
  return req.user?.id || req.authUser?.id || null;
}

async function sb(path, options, c) {
  return fetch(`${c.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    signal: AbortSignal.timeout(12_000),
  });
}

function sanitizeAlert(body, uid) {
  const name = String(body.alert_name || body.alertName || '').trim().slice(0, 120);
  if (!name) return { error: 'Zadejte název hlídacího psa.' };

  const deal_types = Array.isArray(body.deal_types || body.dealTypes)
    ? (body.deal_types || body.dealTypes).map(String)
    : ['sale'];
  const property_types = Array.isArray(body.property_types || body.propertyTypes)
    ? (body.property_types || body.propertyTypes).map(String)
    : ['flat'];

  return {
    row: {
      user_id: uid,
      alert_name: name,
      deal_types,
      property_types,
      min_price: body.min_price ?? body.minPrice ?? null,
      max_price: body.max_price ?? body.maxPrice ?? null,
      min_surface: body.min_surface ?? body.minSurface ?? null,
      max_surface: body.max_surface ?? body.maxSurface ?? null,
      districts: Array.isArray(body.districts) ? body.districts.map(String).slice(0, 40) : [],
      regions: Array.isArray(body.regions) ? body.regions.map(String).slice(0, 20) : [],
      layouts: Array.isArray(body.layouts) ? body.layouts.map(String).slice(0, 20) : [],
      private_seller_only: Boolean(body.private_seller_only ?? body.privateSellerOnly),
      price_drop_priority: body.price_drop_priority !== false && body.priceDropPriority !== false,
      notification_channels: Array.isArray(body.notification_channels || body.notificationChannels)
        ? (body.notification_channels || body.notificationChannels).map(String)
        : ['in_app'],
      notify_email: body.notify_email || body.notifyEmail
        ? String(body.notify_email || body.notifyEmail).trim().slice(0, 200)
        : null,
      is_active: body.is_active !== false && body.isActive !== false,
      updated_at: new Date().toISOString(),
    },
  };
}

router.get('/alerts', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });
    const c = cfg();
    if (!c.enabled) return res.status(503).json({ error: 'Supabase není nastaven.' });

    const r = await sb(
      `radar_alerts?user_id=eq.${encodeURIComponent(uid)}&order=created_at.desc`,
      { headers: headers(c.serviceKey) },
      c,
    );
    if (!r.ok) {
      return res.status(502).json({ error: 'Nepodařilo se načíst alerty.', detail: await r.text() });
    }
    res.json({ alerts: await r.json() });
  } catch (e) {
    next(e);
  }
});

router.post('/alerts', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });
    const c = cfg();
    if (!c.enabled) return res.status(503).json({ error: 'Supabase není nastaven.' });

    const { row, error } = sanitizeAlert(req.body || {}, uid);
    if (error) return res.status(400).json({ error });

    const r = await sb(
      'radar_alerts',
      { method: 'POST', headers: headers(c.serviceKey), body: JSON.stringify(row) },
      c,
    );
    if (!r.ok) {
      return res.status(502).json({ error: 'Uložení alertu selhalo.', detail: await r.text() });
    }
    const rows = await r.json();
    res.status(201).json({ alert: Array.isArray(rows) ? rows[0] : rows });
  } catch (e) {
    next(e);
  }
});

router.patch('/alerts/:id', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });
    const c = cfg();
    if (!c.enabled) return res.status(503).json({ error: 'Supabase není nastaven.' });

    const id = String(req.params.id || '');
    const { row, error } = sanitizeAlert({ ...req.body, alert_name: req.body.alert_name || req.body.alertName || 'Hlídací pes' }, uid);
    if (error) return res.status(400).json({ error });
    delete row.user_id;

    const r = await sb(
      `radar_alerts?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(uid)}`,
      { method: 'PATCH', headers: headers(c.serviceKey), body: JSON.stringify(row) },
      c,
    );
    if (!r.ok) {
      return res.status(502).json({ error: 'Úprava alertu selhala.', detail: await r.text() });
    }
    const rows = await r.json();
    res.json({ alert: Array.isArray(rows) ? rows[0] : rows });
  } catch (e) {
    next(e);
  }
});

router.delete('/alerts/:id', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });
    const c = cfg();
    if (!c.enabled) return res.status(503).json({ error: 'Supabase není nastaven.' });

    const id = String(req.params.id || '');
    const r = await sb(
      `radar_alerts?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(uid)}`,
      { method: 'DELETE', headers: headers(c.serviceKey, { Prefer: 'return=minimal' }) },
      c,
    );
    if (!r.ok) {
      return res.status(502).json({ error: 'Smazání selhalo.', detail: await r.text() });
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.get('/matches', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });
    const c = cfg();
    if (!c.enabled) return res.status(503).json({ error: 'Supabase není nastaven.' });

    const unreadOnly = String(req.query.unread || '') === '1';
    let q =
      `radar_matches?user_id=eq.${encodeURIComponent(uid)}` +
      `&select=*,listing:radar_listings(id,title,price,locality,source,source_url,thumbnail_url,is_private_seller,last_price_drop,layout,floor_area)` +
      `&order=created_at.desc&limit=50`;
    if (unreadOnly) q += '&is_read=eq.false';

    const r = await sb(q, { headers: headers(c.serviceKey) }, c);
    if (!r.ok) {
      return res.status(502).json({ error: 'Nepodařilo se načíst matches.', detail: await r.text() });
    }
    res.json({ matches: await r.json() });
  } catch (e) {
    next(e);
  }
});

router.post('/matches/:id/read', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });
    const c = cfg();
    if (!c.enabled) return res.status(503).json({ error: 'Supabase není nastaven.' });

    const id = String(req.params.id || '');
    const r = await sb(
      `radar_matches?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(uid)}`,
      {
        method: 'PATCH',
        headers: headers(c.serviceKey),
        body: JSON.stringify({ is_read: true }),
      },
      c,
    );
    if (!r.ok) return res.status(502).json({ error: 'Update selhal.' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/matches/read-all', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });
    const c = cfg();
    if (!c.enabled) return res.status(503).json({ error: 'Supabase není nastaven.' });

    const r = await sb(
      `radar_matches?user_id=eq.${encodeURIComponent(uid)}&is_read=eq.false`,
      {
        method: 'PATCH',
        headers: headers(c.serviceKey),
        body: JSON.stringify({ is_read: true }),
      },
      c,
    );
    if (!r.ok) return res.status(502).json({ error: 'Hromadné označení selhalo.' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
