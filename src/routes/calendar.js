/**
 * Google Calendar — OAuth connect + push/pull sync
 */

import { Router } from 'express';
import {
  isGoogleCalendarConfigured,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  refreshGoogleAccessToken,
  pushEventToGoogleCalendar,
  loadCalendarIntegration,
  saveCalendarIntegration,
  deleteCalendarIntegration,
  updateCalendarIntegration,
  loadIntegrationByWatchChannel,
  pullCalendarForUser,
  setupCalendarWatchForUser,
  stopCalendarWatch,
  calendarWebhookUrl,
} from '../services/googleCalendar.js';

const router = Router();

function userId(req) {
  return req.user?.id || req.authUser?.id || null;
}

/** Stav integrace pro přihlášeného makléře */
router.get('/google/status', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });

    const configured = isGoogleCalendarConfigured();
    if (!configured) {
      return res.json({ configured: false, connected: false });
    }

    const integration = await loadCalendarIntegration(uid);
    res.json({
      configured: true,
      connected: Boolean(integration?.refresh_token),
      email: integration?.connected_email || null,
      calendarId: integration?.calendar_id || 'primary',
      lastSyncedAt: integration?.last_synced_at || null,
      webhookEnabled: Boolean(calendarWebhookUrl()),
      needsSync: Boolean(integration?.needs_sync),
    });
  } catch (error) {
    next(error);
  }
});

/** Vrátí URL pro OAuth (frontend přesměruje okno) */
router.get('/google/connect-url', (req, res) => {
  const uid = userId(req);
  if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });
  if (!isGoogleCalendarConfigured()) {
    return res.status(503).json({
      error: 'Google Calendar není nakonfigurován.',
      hint: 'Doplňte GOOGLE_CLIENT_ID a GOOGLE_CLIENT_SECRET v backend .env',
    });
  }

  const state = Buffer.from(JSON.stringify({ uid, ts: Date.now() })).toString('base64url');
  res.json({ url: buildGoogleAuthUrl(state), state });
});

/** OAuth callback — veřejná cesta (Google redirect) */
router.get('/google/callback', async (req, res) => {
  const frontend = String(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  const fail = (msg) =>
    res.redirect(`${frontend}/?calendar=error&msg=${encodeURIComponent(msg)}`);

  try {
    const { code, state, error } = req.query;
    if (error) return fail(String(error));
    if (!code) return fail('Chybí autorizační kód');

    let uid;
    try {
      const parsed = JSON.parse(Buffer.from(String(state || ''), 'base64url').toString('utf8'));
      uid = parsed.uid;
    } catch {
      return fail('Neplatný OAuth state');
    }
    if (!uid) return fail('Chybí user ID');

    const tokens = await exchangeGoogleCode(code);
    if (!tokens.refresh_token) {
      return fail('Google nevrátil refresh token — zkuste znovu s prompt=consent');
    }

    await saveCalendarIntegration(uid, {
      refreshToken: tokens.refresh_token,
      connectedEmail: null,
    });

    const integration = await loadCalendarIntegration(uid);
    if (integration) {
      try {
        await setupCalendarWatchForUser(uid, integration);
      } catch (watchErr) {
        console.warn('[Google Calendar watch]', watchErr.message);
      }
    }

    res.redirect(`${frontend}/?calendar=connected`);
  } catch (e) {
    fail(e.message || 'Propojení selhalo');
  }
});

/** Google push webhook — veřejná cesta */
router.post('/google/webhook', async (req, res) => {
  try {
    const channelId = String(req.headers['x-goog-channel-id'] || '').trim();
    const resourceState = String(req.headers['x-goog-resource-state'] || '').trim();

    if (channelId && (resourceState === 'exists' || resourceState === 'sync')) {
      const integration = await loadIntegrationByWatchChannel(channelId);
      if (integration?.user_id) {
        await updateCalendarIntegration(integration.user_id, { needs_sync: true });
      }
    }

    res.status(200).end();
  } catch {
    res.status(200).end();
  }
});

/** Odpojit Google Calendar */
router.delete('/google/disconnect', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });

    const integration = await loadCalendarIntegration(uid);
    if (integration?.refresh_token && integration.watch_channel_id && integration.watch_resource_id) {
      try {
        const accessToken = await refreshGoogleAccessToken(integration.refresh_token);
        await stopCalendarWatch({
          accessToken,
          channelId: integration.watch_channel_id,
          resourceId: integration.watch_resource_id,
        });
      } catch {
        /* ignore */
      }
    }

    await deleteCalendarIntegration(uid);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** Pull změn z Google Calendar → Makio agenda */
router.post('/google/pull', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });
    if (!isGoogleCalendarConfigured()) {
      return res.status(503).json({ error: 'Google Calendar není nakonfigurován.' });
    }

    const integration = await loadCalendarIntegration(uid);
    if (!integration?.refresh_token) {
      return res.status(400).json({
        error: 'Google Calendar není propojený.',
        code: 'NOT_CONNECTED',
      });
    }

    const result = await pullCalendarForUser(uid, integration);
    if (result.error === 'NOT_CONNECTED') {
      return res.status(400).json({ error: 'Google Calendar není propojený.', code: 'NOT_CONNECTED' });
    }

    res.json({
      ok: true,
      events: result.events,
      syncedAt: result.syncedAt,
      imported: result.events.filter((e) => !e.cancelled).length,
      cancelled: result.events.filter((e) => e.cancelled).length,
    });
  } catch (error) {
    next(error);
  }
});

/** Push jedné události do Google Calendar */
router.post('/google/push-event', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'Přihlášení vyžadováno.' });
    if (!isGoogleCalendarConfigured()) {
      return res.status(503).json({ error: 'Google Calendar není nakonfigurován.' });
    }

    const integration = await loadCalendarIntegration(uid);
    if (!integration?.refresh_token) {
      return res.status(400).json({
        error: 'Google Calendar není propojený.',
        code: 'NOT_CONNECTED',
      });
    }

    const { event, externalEventId } = req.body || {};
    if (!event?.title) {
      return res.status(400).json({ error: 'Chybí event.title' });
    }

    const accessToken = await refreshGoogleAccessToken(integration.refresh_token);
    const result = await pushEventToGoogleCalendar({
      accessToken,
      calendarId: integration.calendar_id || 'primary',
      event,
      externalEventId: externalEventId || event.external_event_id || event.externalEventId,
    });

    res.json({
      ok: true,
      googleEventId: result.googleEventId,
      htmlLink: result.htmlLink,
      syncStatus: 'synced',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
