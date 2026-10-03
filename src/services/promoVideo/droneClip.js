/**
 * Single exterior → short AI "drone" clip (cost-capped Wan by default).
 */

import { startI2V, pollI2V, getConfiguredProviderId } from '../videoProviders/index.js';
import { resolveDroneSecondsForBudget } from './costModel.js';

const DRONE_PROMPT =
  'Cinematic real-estate aerial-style approach. Slow gentle crane-up / push-in over the building facade, ' +
  'natural daylight, keep exact architecture and windows locked, no morphing, no invented cars or people, ' +
  'smooth stabilized camera, premium listing promo, high fidelity to source photo.';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {{ exteriorPhotoUrl: string, aspectRatio?: string, scriptChars?: number }} opts
 */
export async function generateDroneClip(opts) {
  const skip = String(process.env.PROMO_DRONE_PROVIDER || 'wan').toLowerCase() === 'none';
  if (skip || !opts.exteriorPhotoUrl) {
    return { videoUrl: null, provider: 'none', seconds: 0, skipped: true };
  }

  const preferred = String(process.env.PROMO_DRONE_PROVIDER || 'wan').toLowerCase();
  const seconds = resolveDroneSecondsForBudget({
    droneProvider: preferred,
    scriptChars: opts.scriptChars,
  });

  if (seconds <= 0) {
    return {
      videoUrl: null,
      provider: 'budget_skip',
      seconds: 0,
      skipped: true,
      reason: 'AI drone by přesáhl budget 4 Kč — pouze Ken Burns.',
    };
  }

  // Force wan for cost unless explicitly kling/hailuo
  const prev = process.env.REEL_VIDEO_PROVIDER;
  if (preferred === 'kling' || preferred === 'wan' || preferred === 'seedance') {
    process.env.REEL_VIDEO_PROVIDER = preferred;
  } else {
    process.env.REEL_VIDEO_PROVIDER = 'wan';
  }

  let started;
  try {
    started = await startI2V({
      imageUrl: opts.exteriorPhotoUrl,
      prompt: DRONE_PROMPT,
      cameraPresetId: 'crane_up',
      aspectRatio: opts.aspectRatio === '16:9' ? '16:9' : '9:16',
    });
  } finally {
    if (prev === undefined) delete process.env.REEL_VIDEO_PROVIDER;
    else process.env.REEL_VIDEO_PROVIDER = prev;
  }

  if (started.demo || started.provider === 'mock') {
    return {
      videoUrl: started.videoUrl || process.env.STAGING_VIDEO_DEMO_MP4 || null,
      provider: 'mock',
      seconds,
      demo: true,
    };
  }

  const deadline = Date.now() + Number(process.env.PROMO_DRONE_TIMEOUT_MS || 180_000);
  let videoUrl = null;
  while (Date.now() < deadline) {
    const polled = await pollI2V(started.providerJobId, started.statusUrl, started.provider);
    if (polled.status === 'completed' && polled.videoUrl) {
      videoUrl = polled.videoUrl;
      break;
    }
    if (polled.status === 'failed') {
      const msg =
        typeof polled.error === 'string'
          ? polled.error
          : polled.error?.message || JSON.stringify(polled.error || {}).slice(0, 200) || 'Drone I2V selhalo';
      throw Object.assign(new Error(msg), { status: 502 });
    }
    await sleep(2500);
  }

  if (!videoUrl) {
    throw Object.assign(new Error('Timeout při generování drone klipu.'), { status: 504 });
  }

  return {
    videoUrl,
    provider: getConfiguredProviderId(),
    seconds,
    providerJobId: started.providerJobId,
  };
}
