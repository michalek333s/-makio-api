/**
 * fal.ai image→video via queue API.
 * Models: wan (default cost), seedance, kling
 * Env: FAL_KEY, FAL_WAN_MODEL, FAL_SEEDANCE_MODEL, FAL_KLING_MODEL, FAL_WAN_RESOLUTION
 */

import { stringifyError } from '../../lib/stringifyError.js';

const QUEUE_BASE = 'https://queue.fal.run';

const DEFAULT_MODELS = {
  // Wan 2.2 A14B — lepší věrnost fotce než legacy fal-ai/wan-i2v
  wan: 'fal-ai/wan/v2.2-a14b/image-to-video',
  seedance: 'bytedance/seedance-2.0/fast/image-to-video',
  kling: 'fal-ai/kling-video/v2.1/standard/image-to-video',
};

const FIDELITY_FALLBACK =
  '9:16 real-estate plate. Extremely slow micro camera move. Exact source furniture locked, no morphing.';

function falDetailMessage(data, fallback) {
  return stringifyError(
    data?.detail ?? data?.error ?? data?.message ?? data,
    fallback,
  );
}

export function isFalConfigured() {
  return Boolean(String(process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim());
}

function falKey() {
  return String(process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim();
}

function modelId(kind) {
  if (kind === 'kling') {
    return String(process.env.FAL_KLING_MODEL || DEFAULT_MODELS.kling).trim();
  }
  if (kind === 'wan') {
    return String(process.env.FAL_WAN_MODEL || DEFAULT_MODELS.wan).trim();
  }
  return String(process.env.FAL_SEEDANCE_MODEL || DEFAULT_MODELS.seedance).trim();
}

function wanResolution() {
  const r = String(process.env.FAL_WAN_RESOLUTION || '720p').toLowerCase().trim();
  if (r === '480p' || r === '580p' || r === '720p') return r;
  return '720p';
}

function authHeaders() {
  return {
    Authorization: `Key ${falKey()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function buildInput(model, imageUrl, prompt, aspectRatio) {
  const p = prompt || FIDELITY_FALLBACK;
  if (model === 'kling') {
    return {
      prompt: p,
      start_image_url: imageUrl,
      aspect_ratio: aspectRatio,
      duration: '5',
    };
  }
  if (model === 'wan') {
    // Safety checker často falešně blokuje interiéry bytů — default vypnutý (FAL_WAN_SAFETY=1 zapne).
    const safetyOn = String(process.env.FAL_WAN_SAFETY || '').trim() === '1';
    return {
      prompt: p,
      image_url: imageUrl,
      resolution: wanResolution(),
      num_frames: Number(process.env.FAL_WAN_NUM_FRAMES || 81) || 81,
      frames_per_second: Number(process.env.FAL_WAN_FPS || 16) || 16,
      aspect_ratio: '9:16',
      enable_safety_checker: safetyOn,
      enable_prompt_expansion: false, // expansion often invents furniture
      video_quality: String(process.env.FAL_WAN_VIDEO_QUALITY || 'high').trim() || 'high',
    };
  }
  // seedance
  return {
    prompt: p,
    image_url: imageUrl,
    aspect_ratio: aspectRatio,
    duration: '4',
    generate_audio: false,
    resolution: '720p',
  };
}

/**
 * @param {{ model: 'wan'|'seedance'|'kling', imageUrl: string, prompt: string, aspectRatio?: string }} opts
 */
export async function startFalI2V({ model, imageUrl, prompt, aspectRatio = '9:16' }) {
  if (!isFalConfigured()) {
    throw Object.assign(new Error('FAL_KEY není nastaven v nemio-backend/.env'), { status: 503 });
  }
  if (!/^https:\/\//i.test(String(imageUrl || ''))) {
    throw Object.assign(
      new Error('Fotka musí být veřejná https URL (fal ji stáhne ze storage).'),
      { status: 400, code: 'REEL_IMAGE_NOT_PUBLIC' },
    );
  }
  // Rychlá kontrola dostupnosti — fal často vrací opaque detail, když URL nejde stáhnout
  try {
    const head = await fetch(imageUrl, { method: 'HEAD' });
    if (!head.ok) {
      const get = await fetch(imageUrl, { method: 'GET', headers: { Range: 'bytes=0-0' } });
      if (!get.ok) {
        throw Object.assign(
          new Error(
            `Fotka není veřejně dostupná (${get.status}). Zkontrolujte bucket staging-uploads (public) v Supabase.`,
          ),
          { status: 400, code: 'REEL_IMAGE_UNREACHABLE' },
        );
      }
    }
  } catch (e) {
    if (e.code === 'REEL_IMAGE_UNREACHABLE') throw e;
    // síťová chyba při HEAD — necháme fal, ať zkusí
  }

  const kind = model === 'kling' || model === 'wan' ? model : 'seedance';
  const mid = modelId(kind);
  const input = buildInput(kind, imageUrl, prompt, aspectRatio);

  const res = await fetch(`${QUEUE_BASE}/${mid}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = falDetailMessage(data, `fal error ${res.status}`);
    const low =
      res.status === 403 ||
      /exhaust|balance|locked|insufficient|credit|billing/i.test(String(msg));
    if (low) {
      msg =
        'fal.ai: nedostatek kreditů (účet uzamčen). Dobijte zůstatek na https://fal.ai/dashboard/billing';
    }
    throw Object.assign(new Error(msg), {
      status: res.status >= 400 && res.status < 600 ? res.status : 502,
      code: low ? 'FAL_NO_CREDITS' : 'FAL_ERROR',
      raw: data,
    });
  }

  const requestId = data.request_id || data.requestId || data.id;
  if (!requestId) {
    throw Object.assign(new Error('fal: chybí request_id'), { status: 502, raw: data });
  }

  const statusUrl =
    data.status_url || `${QUEUE_BASE}/${mid}/requests/${requestId}/status`;
  const responseUrl =
    data.response_url || `${QUEUE_BASE}/${mid}/requests/${requestId}`;

  return {
    provider: kind,
    providerJobId: `fal-${requestId}`,
    statusUrl,
    responseUrl,
    falModel: mid,
    falRequestId: requestId,
    status: 'queued',
    demo: false,
    raw: data,
  };
}

export async function pollFalI2V(providerJobId, statusUrl) {
  if (!isFalConfigured()) {
    return { status: 'failed', error: 'FAL_KEY chybí' };
  }
  const requestId = String(providerJobId || '').replace(/^fal-/, '');
  let url = statusUrl;
  if (!url && requestId) {
    return { status: 'failed', error: 'Chybí fal statusUrl' };
  }

  const statusRes = await fetch(url, { headers: authHeaders() });
  const statusData = await statusRes.json().catch(() => ({}));
  if (!statusRes.ok) {
    return {
      status: 'failed',
      error: falDetailMessage(statusData, `fal status ${statusRes.status}`),
    };
  }

  const st = String(statusData.status || statusData.request_status || '').toUpperCase();
  if (st === 'IN_QUEUE' || st === 'IN_PROGRESS' || st === 'QUEUED') {
    return {
      status: st === 'IN_QUEUE' || st === 'QUEUED' ? 'queued' : 'processing',
      progress: st === 'IN_PROGRESS' ? 55 : 20,
      raw: statusData,
    };
  }
  if (st === 'FAILED' || st === 'CANCELLED' || st === 'CANCELED') {
    return {
      status: 'failed',
      error: falDetailMessage(statusData, 'fal generation failed'),
      raw: statusData,
    };
  }

  const responseUrl =
    statusData.response_url ||
    (url.includes('/status') ? url.replace(/\/status\/?$/, '') : null);
  if (!responseUrl) {
    const direct =
      statusData.video?.url ||
      statusData.video_url ||
      statusData.output?.video?.url ||
      statusData.output?.url;
    if (direct) return { status: 'completed', videoUrl: direct, progress: 100, raw: statusData };
    return { status: 'processing', progress: 70, raw: statusData };
  }

  const resultRes = await fetch(responseUrl, { headers: authHeaders() });
  const result = await resultRes.json().catch(() => ({}));
  if (!resultRes.ok) {
    return {
      status: 'failed',
      error: falDetailMessage(result, `fal result ${resultRes.status}`),
    };
  }

  const videoUrl =
    result.video?.url ||
    result.video_url ||
    result.output?.video?.url ||
    result.output?.url ||
    (Array.isArray(result.videos) ? result.videos[0]?.url : null);

  if (!videoUrl) {
    return { status: 'failed', error: 'fal: video URL chybí ve výsledku', raw: result };
  }
  return { status: 'completed', videoUrl, progress: 100, raw: result };
}
