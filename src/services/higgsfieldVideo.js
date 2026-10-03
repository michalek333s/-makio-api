/**
 * Higgsfield image→video wrapper (DoP / platform API).
 * Auth: HF_CREDENTIALS="KEY_ID:KEY_SECRET" or HF_API_KEY + HF_API_SECRET
 * Bez kreditů / free test: HF_FORCE_MOCK=1 → lokální demo video (nevolá Higgsfield).
 */

import { randomUUID } from 'crypto';
import { REEL_MOTION_TEMPLATES } from '../prompts/reelDirectorMasterPrompt.js';

const BASE = String(process.env.HIGGSFIELD_BASE_URL || 'https://platform.higgsfield.ai').replace(/\/$/, '');

export const CAMERA_PRESETS = {
  dolly_in: {
    id: 'dolly_in',
    label: 'Příbližení do prostoru',
    emoji: '🔍',
    prompt:
      REEL_MOTION_TEMPLATES.dolly_in,
  },
  pan_right: {
    id: 'pan_right',
    label: 'Pomalý posun vpravo',
    emoji: '🎥',
    prompt:
      REEL_MOTION_TEMPLATES.pan_right,
  },
  orbit: {
    id: 'orbit',
    label: 'Jemný krouživý pohyb',
    emoji: '🔄',
    prompt:
      REEL_MOTION_TEMPLATES.orbit,
  },
  crane_up: {
    id: 'crane_up',
    label: 'Přízemní výtah / Odhalení',
    emoji: '⬆️',
    prompt:
      REEL_MOTION_TEMPLATES.crane_up,
  },
  // legacy aliases
  slow_pan_right: {
    id: 'slow_pan_right',
    label: 'Slow Pan Right',
    emoji: '📸',
    prompt: REEL_MOTION_TEMPLATES.pan_right,
  },
  dolly_zoom_in: {
    id: 'dolly_zoom_in',
    label: 'Dolly Zoom In',
    emoji: '🔍',
    prompt: REEL_MOTION_TEMPLATES.dolly_in,
  },
  subtle_orbit: {
    id: 'subtle_orbit',
    label: 'Subtle Orbit',
    emoji: '🔄',
    prompt: REEL_MOTION_TEMPLATES.orbit,
  },
  reveal_up: {
    id: 'reveal_up',
    label: 'Přízemní výtah',
    emoji: '⬆️',
    prompt: REEL_MOTION_TEMPLATES.crane_up,
  },
};

export function getCameraPreset(id) {
  return CAMERA_PRESETS[id] || null;
}

function getCredentials() {
  const single = String(process.env.HF_CREDENTIALS || process.env.HIGGSFIELD_CREDENTIALS || '').trim();
  if (single.includes(':')) return single;
  const key = String(process.env.HF_API_KEY || process.env.HIGGSFIELD_API_KEY || '').trim();
  const secret = String(process.env.HF_API_SECRET || process.env.HIGGSFIELD_API_SECRET || '').trim();
  if (key && secret) return `${key}:${secret}`;
  return '';
}

/** Free test bez placení Higgsfieldu (klíče můžou zůstat v .env). */
export function isHiggsfieldMockForced() {
  const v = String(process.env.HF_FORCE_MOCK || process.env.REEL_VIDEO_MOCK || '').trim();
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

/** Máme API klíče a neběží nucený mock. */
export function isHiggsfieldConfigured() {
  return Boolean(getCredentials()) && !isHiggsfieldMockForced();
}

function shouldUseMockVideo() {
  if (isHiggsfieldMockForced()) return true;
  if (getCredentials()) return false;
  if (process.env.NODE_ENV === 'production' && process.env.STAGING_VIDEO_ALLOW_MOCK !== '1') {
    return false;
  }
  return true;
}

function authHeaders() {
  const creds = getCredentials();
  return {
    Authorization: `Key ${creds}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/** In-memory mock jobs for local demo without HF keys */
const mockJobs = new Map();

function startMockJob({ urls, cameraPresetId }) {
  const id = `mock-${randomUUID()}`;
  mockJobs.set(id, {
    createdAt: Date.now(),
    status: 'queued',
    imageUrl: urls[0],
    imageUrls: urls,
    preset: cameraPresetId,
  });
  return {
    provider: 'mock',
    providerJobId: id,
    statusUrl: null,
    status: 'queued',
    demo: true,
  };
}

/**
 * @param {{ imageUrl?: string, imageUrls?: string[], cameraPresetId: string, cameraPrompt?: string }} params
 */
export async function startImageToVideo({ imageUrl, imageUrls, cameraPresetId, cameraPrompt }) {
  const preset = getCameraPreset(cameraPresetId);
  if (!preset) {
    throw Object.assign(new Error('Neplatný camera preset.'), { status: 400 });
  }
  const urls = (Array.isArray(imageUrls) ? imageUrls : [])
    .map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//i.test(u));
  if (imageUrl && /^https?:\/\//i.test(imageUrl) && !urls.includes(imageUrl)) {
    urls.unshift(String(imageUrl).trim());
  }
  if (!urls.length) {
    throw Object.assign(new Error('sourceImageUrl musí být veřejná http(s) URL.'), { status: 400 });
  }

  const prompt = String(cameraPrompt || preset.prompt || '').trim() || preset.prompt;

  if (shouldUseMockVideo()) {
    if (!getCredentials() && !isHiggsfieldMockForced() && process.env.NODE_ENV === 'production' && process.env.STAGING_VIDEO_ALLOW_MOCK !== '1') {
      throw Object.assign(new Error('Higgsfield API není nakonfigurováno (HF_CREDENTIALS).'), { status: 503 });
    }
    return startMockJob({ urls, cameraPresetId });
  }

  const endpoint = String(process.env.HIGGSFIELD_I2V_ENDPOINT || '/v1/image2video/dop');
  const model = String(process.env.HIGGSFIELD_I2V_MODEL || 'dop-turbo');

  // Oficiální API očekává body.params (ne flat JSON) — jinak 422 Field required.
  const params = {
    model,
    prompt,
    input_images: urls.map((image_url) => ({ type: 'image_url', image_url })),
  };

  const res = await fetch(`${BASE}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'User-Agent': 'higgsfield-server-js/2.0',
    },
    body: JSON.stringify({ params }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = formatHiggsfieldError(data, res.status);
    throw Object.assign(new Error(detail), {
      status: res.status >= 400 && res.status < 600 ? res.status : 502,
      code: res.status === 403 ? 'HF_NO_CREDITS' : 'HF_ERROR',
      raw: data,
    });
  }

  const requestId = data.request_id || data.id || data.job_set_id || null;
  return {
    provider: 'higgsfield',
    providerJobId: requestId,
    statusUrl: data.status_url || (requestId ? `${BASE}/requests/${requestId}/status` : null),
    status: data.status || 'queued',
    demo: false,
    raw: data,
  };
}

function formatHiggsfieldError(data, status) {
  if (typeof data?.detail === 'string') {
    if (/not enough credits/i.test(data.detail)) {
      return 'Higgsfield: došly kredity na účtu. Dobijte je na cloud.higgsfield.ai.';
    }
    return `Higgsfield: ${data.detail}`;
  }
  if (Array.isArray(data?.detail)) {
    const msgs = data.detail
      .map((d) => d?.msg || d?.message || JSON.stringify(d))
      .filter(Boolean)
      .slice(0, 3);
    if (msgs.length) return `Higgsfield ${status}: ${msgs.join('; ')}`;
  }
  if (data?.message) return String(data.message);
  if (data?.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
  return `Higgsfield error ${status}`;
}

export async function pollImageToVideo(providerJobId, statusUrl) {
  if (String(providerJobId || '').startsWith('mock-')) {
    const job = mockJobs.get(providerJobId);
    if (!job) return { status: 'failed', error: 'Mock job not found' };
    const age = Date.now() - job.createdAt;
    if (age < 4000) return { status: 'processing', progress: Math.min(90, Math.round(age / 50)) };
    // Public sample vertical clip for UI wiring (not real staging)
    return {
      status: 'completed',
      videoUrl:
        process.env.STAGING_VIDEO_DEMO_MP4 ||
        'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
      demo: true,
      progress: 100,
    };
  }

  if (!isHiggsfieldConfigured()) {
    return { status: 'failed', error: 'Higgsfield není nakonfigurováno' };
  }

  const url =
    statusUrl ||
    (providerJobId ? `${BASE}/requests/${providerJobId}/status` : null);
  if (!url) return { status: 'failed', error: 'Chybí status URL' };

  const res = await fetch(url, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      status: 'failed',
      error: data?.message || data?.error || `Status HTTP ${res.status}`,
    };
  }

  const status = String(data.status || '').toLowerCase();
  const videoUrl =
    data.video?.url ||
    data.videos?.[0]?.url ||
    data.jobs?.[0]?.results?.raw?.url ||
    data.result?.url ||
    null;

  if (status === 'completed' || status === 'complete' || status === 'succeeded') {
    return { status: 'completed', videoUrl, raw: data, progress: 100 };
  }
  if (status === 'failed' || status === 'nsfw' || status === 'canceled') {
    return {
      status: 'failed',
      error: status === 'nsfw' ? 'Obsah odmítnut moderací.' : data.error || 'Generování selhalo.',
      raw: data,
    };
  }
  if (status === 'queued') return { status: 'queued', progress: 10, raw: data };
  return { status: 'processing', progress: 50, raw: data };
}
