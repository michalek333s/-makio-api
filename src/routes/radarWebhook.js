/**
 * Apify → Makio Radar Watchdog webhook (veřejný endpoint, auth přes tajný token).
 * POST /api/webhooks/radar
 */

import { Router } from 'express';
import { ingestRadarWebhookItems } from '../services/radarWatchdogIngest.js';

const router = Router();

function extractItems(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.datasetItems)) return body.datasetItems;
  // Apify webhook default payload
  if (body.resource?.defaultDatasetId && Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.data)) return body.data;
  return [];
}

function authorizeWebhook(req) {
  const secret = String(process.env.APIFY_WEBHOOK_SECRET || process.env.RADAR_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    return { ok: false, status: 503, error: 'APIFY_WEBHOOK_SECRET není nastaven na backendu.' };
  }

  const headerToken =
    String(req.headers['x-radar-webhook-token'] || '').trim() ||
    String(req.headers['x-apify-webhook-secret'] || '').trim() ||
    String(req.headers['x-apify-signature'] || '').trim();

  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const queryToken = String(req.query?.token || '').trim();

  const candidate = headerToken || bearer || queryToken;
  if (!candidate || candidate !== secret) {
    return { ok: false, status: 401, error: 'Neplatný webhook token.' };
  }
  return { ok: true };
}

router.post('/', async (req, res, next) => {
  try {
    const auth = authorizeWebhook(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const body = req.body || {};
    let items = extractItems(body);

    // Apify často pošle jen event — dataset stáhneme my
    const datasetId =
      body.resource?.defaultDatasetId ||
      body.defaultDatasetId ||
      body.datasetId ||
      null;

    if ((!items || items.length === 0) && datasetId && process.env.APIFY_TOKEN) {
      const { getDatasetItems } = await import('../services/apify.js');
      items = await getDatasetItems(datasetId);
    }

    if (!items?.length) {
      return res.status(200).json({
        ok: true,
        stored: 0,
        matches: 0,
        message: 'Webhook přijat, ale bez items / datasetu.',
      });
    }

    const meta = {
      region: body.region || body.userData?.region || undefined,
      propertyType: body.propertyType || body.userData?.propertyType || 'byty',
      offerType: body.offerType || 'prodej',
      source: body.source || 'sreality',
    };

    const result = await ingestRadarWebhookItems(items, meta);
    res.json({
      message: `Ingest: ${result.stored} uloženo, ${result.matches} matchů, ${result.priceDrops || 0} slev.`,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
