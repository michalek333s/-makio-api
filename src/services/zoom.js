import { normalizeTime } from '../lib/eventDates.js';

const TOKEN_URL = 'https://zoom.us/oauth/token';
const API_BASE = 'https://api.zoom.us/v2';

let tokenCache = { accessToken: null, expiresAt: 0 };

export function isZoomConfigured() {
  return !!(
    process.env.ZOOM_ACCOUNT_ID?.trim() &&
    process.env.ZOOM_CLIENT_ID?.trim() &&
    process.env.ZOOM_CLIENT_SECRET?.trim() &&
    (process.env.ZOOM_HOST_USER_ID?.trim() || process.env.ZOOM_USER_EMAIL?.trim())
  );
}

async function getAccessToken() {
  if (!isZoomConfigured()) {
    throw new Error('Zoom není nakonfigurován — doplňte ZOOM_* v nemio-backend/.env');
  }

  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const accountId = process.env.ZOOM_ACCOUNT_ID.trim();
  const clientId = process.env.ZOOM_CLIENT_ID.trim();
  const clientSecret = process.env.ZOOM_CLIENT_SECRET.trim();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(
    `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}` },
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.reason || data.error || res.statusText;
    throw new Error(`Zoom OAuth: ${msg}`);
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + (Number(data.expires_in) || 3600) * 1000,
  };
  return tokenCache.accessToken;
}

async function zoomFetch(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.reason || res.statusText;
    throw new Error(`Zoom API ${res.status}: ${msg}`);
  }
  return data;
}

async function resolveHostUserId() {
  const hostId = process.env.ZOOM_HOST_USER_ID?.trim();
  if (hostId) return hostId;

  const email = process.env.ZOOM_USER_EMAIL?.trim();
  if (!email) {
    throw new Error('Nastavte ZOOM_HOST_USER_ID nebo ZOOM_USER_EMAIL v .env');
  }

  const user = await zoomFetch(`/users/${encodeURIComponent(email)}`);
  if (!user?.id) throw new Error(`Zoom uživatel nenalezen: ${email}`);
  return user.id;
}

/**
 * Vytvoří naplánovanou Zoom schůzku a vrátí join_url.
 */
export async function createZoomMeeting({ topic, dateIso, time, durationMinutes = 60 }) {
  const date = String(dateIso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Neplatné datum schůzky (dateIso)');
  }

  const t = normalizeTime(time);
  const startTime = `${date}T${t}:00`;
  const duration = Math.min(480, Math.max(15, Number(durationMinutes) || 60));
  const userId = await resolveHostUserId();

  const meeting = await zoomFetch(`/users/${encodeURIComponent(userId)}/meetings`, {
    method: 'POST',
    body: {
      topic: String(topic || 'Videohovor Makio').slice(0, 200),
      type: 2,
      start_time: startTime,
      duration,
      timezone: process.env.ZOOM_TIMEZONE?.trim() || 'Europe/Prague',
      settings: {
        join_before_host: true,
        waiting_room: false,
        approval_type: 2,
      },
    },
  });

  if (!meeting?.join_url) {
    throw new Error('Zoom API nevrátilo odkaz na schůzku');
  }

  return {
    joinUrl: meeting.join_url,
    meetingId: meeting.id,
    startUrl: meeting.start_url,
    password: meeting.password || '',
  };
}
