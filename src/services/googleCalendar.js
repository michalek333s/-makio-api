/**
 * Google Calendar — OAuth + push událostí (fetch, bez googleapis balíčku).
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export function isGoogleCalendarConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim(),
  );
}

function redirectUri() {
  const explicit = process.env.GOOGLE_CALENDAR_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const base = process.env.BACKEND_PUBLIC_URL?.trim() || `http://localhost:${process.env.PORT || 3001}`;
  return `${base.replace(/\/$/, '')}/api/calendar/google/callback`;
}

export function buildGoogleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID.trim(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent',
    state: String(state || ''),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleCode(code) {
  const body = new URLSearchParams({
    code: String(code),
    client_id: process.env.GOOGLE_CLIENT_ID.trim(),
    client_secret: process.env.GOOGLE_CLIENT_SECRET.trim(),
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Google OAuth selhalo');
  }
  return data;
}

export async function refreshGoogleAccessToken(refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: process.env.GOOGLE_CLIENT_ID.trim(),
    client_secret: process.env.GOOGLE_CLIENT_SECRET.trim(),
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Obnovení Google tokenu selhalo');
  }
  return data.access_token;
}

function toRfc3339(dateIso, timeLabel) {
  const d = String(dateIso || '').slice(0, 10);
  const t = String(timeLabel || '12:00').match(/(\d{1,2}):(\d{2})/);
  const hh = t ? t[1].padStart(2, '0') : '12';
  const mm = t ? t[2] : '00';
  const start = new Date(`${d}T${hh}:${mm}:00`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (dt) =>
    `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00`;
  return { start: fmt(start), end: fmt(end), timeZone: 'Europe/Prague' };
}

export async function pushEventToGoogleCalendar({ accessToken, calendarId = 'primary', event, externalEventId }) {
  const { start, end, timeZone } = toRfc3339(event.dateIso || event.date_iso, event.time || event.time_label);
  const body = {
    summary: event.title || 'Schůzka Makio',
    description: [
      event.client || event.client_name ? `Klient: ${event.client || event.client_name}` : '',
      event.meetingUrl ? `Odkaz: ${event.meetingUrl}` : '',
      '— synchronizováno z Makio',
    ]
      .filter(Boolean)
      .join('\n'),
    location: event.location || '',
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
  };

  const cal = encodeURIComponent(calendarId || 'primary');
  const method = externalEventId ? 'PATCH' : 'POST';
  const path = externalEventId
    ? `${CALENDAR_API}/calendars/${cal}/events/${encodeURIComponent(externalEventId)}`
    : `${CALENDAR_API}/calendars/${cal}/events`;

  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || data.error || `Google Calendar ${res.status}`);
  }
  return { googleEventId: data.id, htmlLink: data.htmlLink, raw: data };
}

export function calendarDbConfig() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return { enabled: Boolean(supabaseUrl && serviceKey), supabaseUrl, serviceKey };
}

export async function loadCalendarIntegration(userId) {
  const c = calendarDbConfig();
  if (!c.enabled || !userId) return null;

  const res = await fetch(
    `${c.supabaseUrl}/rest/v1/calendar_integrations?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`,
    {
      headers: {
        apikey: c.serviceKey,
        Authorization: `Bearer ${c.serviceKey}`,
      },
      signal: AbortSignal.timeout(12_000),
    },
  );
  const rows = await res.json().catch(() => []);
  if (!res.ok || !Array.isArray(rows) || !rows[0]) return null;
  return rows[0];
}

export async function saveCalendarIntegration(userId, { refreshToken, connectedEmail, calendarId = 'primary' }) {
  const c = calendarDbConfig();
  if (!c.enabled) throw new Error('Supabase není nakonfigurován pro ukládání kalendáře.');

  const row = {
    user_id: userId,
    provider: 'google',
    refresh_token: refreshToken,
    calendar_id: calendarId,
    connected_email: connectedEmail || null,
    updated_at: new Date().toISOString(),
  };

  const res = await fetch(`${c.supabaseUrl}/rest/v1/calendar_integrations`, {
    method: 'POST',
    headers: {
      apikey: c.serviceKey,
      Authorization: `Bearer ${c.serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || 'Uložení kalendářové integrace selhalo');
  }
  return Array.isArray(data) ? data[0] : data;
}

export async function deleteCalendarIntegration(userId) {
  const c = calendarDbConfig();
  if (!c.enabled || !userId) return;
  await fetch(
    `${c.supabaseUrl}/rest/v1/calendar_integrations?user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'DELETE',
      headers: {
        apikey: c.serviceKey,
        Authorization: `Bearer ${c.serviceKey}`,
      },
      signal: AbortSignal.timeout(12_000),
    },
  );
}

export function calendarWebhookUrl() {
  const base = process.env.BACKEND_PUBLIC_URL?.trim();
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/api/calendar/google/webhook`;
}

export async function updateCalendarIntegration(userId, patch) {
  const c = calendarDbConfig();
  if (!c.enabled || !userId) return null;

  const row = { ...patch, updated_at: new Date().toISOString() };
  const res = await fetch(
    `${c.supabaseUrl}/rest/v1/calendar_integrations?user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: c.serviceKey,
        Authorization: `Bearer ${c.serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(12_000),
    },
  );
  const data = await res.json().catch(() => []);
  if (!res.ok) return null;
  return Array.isArray(data) ? data[0] : data;
}

export async function loadIntegrationByWatchChannel(channelId) {
  const c = calendarDbConfig();
  if (!c.enabled || !channelId) return null;

  const res = await fetch(
    `${c.supabaseUrl}/rest/v1/calendar_integrations?watch_channel_id=eq.${encodeURIComponent(channelId)}&select=*&limit=1`,
    {
      headers: {
        apikey: c.serviceKey,
        Authorization: `Bearer ${c.serviceKey}`,
      },
      signal: AbortSignal.timeout(12_000),
    },
  );
  const rows = await res.json().catch(() => []);
  if (!res.ok || !Array.isArray(rows) || !rows[0]) return null;
  return rows[0];
}

function parseGoogleStart(start) {
  const raw = start?.dateTime || start?.date;
  if (!raw) return { dateIso: '', time: '12:00' };
  const isAllDay = Boolean(start?.date && !start?.dateTime);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { dateIso: String(raw).slice(0, 10), time: '12:00' };
  const pad = (n) => String(n).padStart(2, '0');
  const dateIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (isAllDay) return { dateIso, time: '09:00' };
  return { dateIso, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

function extractClientFromDescription(description) {
  const m = String(description || '').match(/Klient:\s*(.+)/i);
  return m ? m[1].split('\n')[0].trim() : '';
}

function extractMeetingUrl(ge) {
  if (ge.hangoutLink) return ge.hangoutLink;
  const m = String(ge.description || '').match(/Odkaz:\s*(https?:\/\/\S+)/i);
  return m ? m[1].trim() : '';
}

export function mapGoogleEventToMakio(ge) {
  if (!ge?.id) return null;
  if (ge.status === 'cancelled') {
    return { externalEventId: ge.id, cancelled: true, externalProvider: 'google' };
  }
  const { dateIso, time } = parseGoogleStart(ge.start);
  const client = extractClientFromDescription(ge.description);
  return {
    externalEventId: ge.id,
    externalProvider: 'google',
    syncStatus: 'synced',
    title: ge.summary || 'Událost',
    dateIso,
    time,
    location: ge.location || '',
    meetingUrl: extractMeetingUrl(ge),
    client,
    type: /video|zoom|meet|teams/i.test(`${ge.description || ''} ${ge.location || ''}`)
      ? 'video'
      : 'meeting',
    htmlLink: ge.htmlLink || null,
    aiGenerated: false,
  };
}

export async function pullGoogleCalendarEvents({ accessToken, calendarId = 'primary', syncToken }) {
  const cal = encodeURIComponent(calendarId || 'primary');
  const params = new URLSearchParams({
    singleEvents: 'true',
    showDeleted: 'true',
    maxResults: '250',
  });

  if (syncToken) {
    params.set('syncToken', syncToken);
  } else {
    const now = new Date();
    const past = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const future = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    params.set('timeMin', past.toISOString());
    params.set('timeMax', future.toISOString());
  }

  const url = `${CALENDAR_API}/calendars/${cal}/events?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(25_000),
  });
  const data = await res.json().catch(() => ({}));

  if (res.status === 410) {
    return { resetSyncToken: true, events: [], nextSyncToken: null };
  }
  if (!res.ok) {
    throw new Error(data.error?.message || data.error || `Google Calendar list ${res.status}`);
  }

  const items = Array.isArray(data.items) ? data.items : [];
  return {
    events: items.map(mapGoogleEventToMakio).filter(Boolean),
    nextSyncToken: data.nextSyncToken || null,
    resetSyncToken: false,
  };
}

export async function registerCalendarWatch({ accessToken, calendarId = 'primary', webhookUrl, channelId }) {
  const cal = encodeURIComponent(calendarId || 'primary');
  const expiration = Date.now() + 6 * 24 * 60 * 60 * 1000;

  const res = await fetch(`${CALENDAR_API}/calendars/${cal}/events/watch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: channelId,
      type: 'web_hook',
      address: webhookUrl,
      expiration: String(expiration),
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || data.error || 'Google watch selhalo');
  }
  return {
    channelId: data.id || channelId,
    resourceId: data.resourceId,
    expiration: data.expiration ? new Date(Number(data.expiration)).toISOString() : null,
  };
}

export async function stopCalendarWatch({ accessToken, channelId, resourceId }) {
  if (!channelId || !resourceId) return;
  await fetch(`${CALENDAR_API}/channels/stop`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: channelId, resourceId }),
    signal: AbortSignal.timeout(12_000),
  }).catch(() => {});
}

export async function setupCalendarWatchForUser(userId, integration) {
  const webhookUrl = calendarWebhookUrl();
  if (!webhookUrl || !integration?.refresh_token) return null;

  const accessToken = await refreshGoogleAccessToken(integration.refresh_token);
  const channelId = `makio-${userId.slice(0, 8)}-${Date.now()}`;

  if (integration.watch_channel_id && integration.watch_resource_id) {
    await stopCalendarWatch({
      accessToken,
      channelId: integration.watch_channel_id,
      resourceId: integration.watch_resource_id,
    }).catch(() => {});
  }

  const watch = await registerCalendarWatch({
    accessToken,
    calendarId: integration.calendar_id || 'primary',
    webhookUrl,
    channelId,
  });

  await updateCalendarIntegration(userId, {
    watch_channel_id: watch.channelId,
    watch_resource_id: watch.resourceId,
    watch_expiration: watch.expiration,
  });

  return watch;
}

export async function pullCalendarForUser(userId, integration) {
  if (!integration?.refresh_token) {
    return { error: 'NOT_CONNECTED', events: [] };
  }

  const accessToken = await refreshGoogleAccessToken(integration.refresh_token);
  let syncToken = integration.sync_token || null;
  let result = await pullGoogleCalendarEvents({
    accessToken,
    calendarId: integration.calendar_id || 'primary',
    syncToken,
  });

  if (result.resetSyncToken) {
    syncToken = null;
    result = await pullGoogleCalendarEvents({
      accessToken,
      calendarId: integration.calendar_id || 'primary',
      syncToken: null,
    });
  }

  await updateCalendarIntegration(userId, {
    sync_token: result.nextSyncToken || syncToken,
    last_synced_at: new Date().toISOString(),
    needs_sync: false,
  });

  return {
    events: result.events,
    syncedAt: new Date().toISOString(),
    nextSyncToken: result.nextSyncToken,
  };
}
