/**
 * Cost-optimized promo video pipeline:
 * script → ElevenLabs(+timestamps) → 1× AI drone (exterior) → Ken Burns interiors → FFmpeg compose
 */

import { randomUUID } from 'crypto';
import { generatePromoScript } from './scriptGenerator.js';
import { synthesizePromoVoiceWithTimestamps } from './elevenTimestamps.js';
import { generateDroneClip } from './droneClip.js';
import { composePromoKenBurnsMp4 } from './kenBurnsCompose.js';
import { estimatePromoCostCzk, resolveDroneSecondsForBudget, PROMO_MAX_COST_CZK } from './costModel.js';

/** @type {Map<string, object>} */
const jobs = new Map();

const STEP_PCT = {
  queued: 5,
  scripting: 15,
  voice: 35,
  drone: 60,
  composing: 85,
  completed: 100,
  failed: 0,
};

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    progress: STEP_PCT[job.step] ?? job.progress ?? 0,
    error: job.error || null,
    videoUrl: job.videoUrl || null,
    script: job.script || null,
    cues: job.cues || [],
    audioUrl: job.audioUrl || null,
    droneVideoUrl: job.droneVideoUrl || null,
    costEstimate: job.costEstimate || null,
    costActualHint: job.costActualHint || null,
    timeline: job.timeline || null,
    aspectRatio: job.aspectRatio,
    durationSec: job.durationSec || null,
    propertyId: job.propertyId || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function getPromoVideoJob(jobId) {
  return publicJob(jobs.get(jobId));
}

function resolveMusicUrl(musicTrackId) {
  if (!musicTrackId) return null;
  if (/^https?:\/\//i.test(musicTrackId)) return musicTrackId;
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const bucket = String(process.env.PROMO_MUSIC_BUCKET || process.env.REEL_UPLOAD_BUCKET || 'staging-uploads');
  if (!base) return null;
  return `${base}/storage/v1/object/public/${bucket}/music/${encodeURIComponent(musicTrackId)}.mp3`;
}

/**
 * @param {import('./types.js').GenerateVideoInput & { userId: string }} input
 */
export async function startPromoVideoPipeline(input) {
  const exterior = String(input.exteriorPhotoUrl || '').trim();
  const interiors = (input.interiorPhotoUrls || []).filter((u) => /^https?:\/\//i.test(u));
  if (!exterior) {
    throw Object.assign(new Error('Chybí exteriorPhotoUrl (drone záběr).'), { status: 400 });
  }
  if (interiors.length < 1) {
    throw Object.assign(new Error('Nahrajte alespoň 1 interiérovou fotku pro Ken Burns.'), { status: 400 });
  }
  if (interiors.length > 8) {
    throw Object.assign(new Error('Maximum 8 interiérových fotek.'), { status: 400 });
  }

  const aspectRatio = input.aspectRatio === '16:9' ? '16:9' : '9:16';
  const droneProvider = String(process.env.PROMO_DRONE_PROVIDER || 'wan').toLowerCase();
  const preCost = estimatePromoCostCzk({
    droneProvider,
    droneSeconds: resolveDroneSecondsForBudget({ droneProvider, scriptChars: 420 }),
    scriptChars: 420,
  });

  const id = randomUUID();
  const job = {
    id,
    userId: input.userId,
    propertyId: input.propertyId || null,
    status: 'queued',
    step: 'queued',
    progress: 5,
    error: null,
    videoUrl: null,
    script: null,
    cues: [],
    audioUrl: null,
    droneVideoUrl: null,
    costEstimate: preCost,
    costActualHint: null,
    timeline: null,
    aspectRatio,
    durationSec: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: {
      exteriorPhotoUrl: exterior,
      interiorPhotoUrls: interiors,
      propertyDetails: input.propertyDetails || {},
      musicTrackId: input.musicTrackId || null,
      voiceId: input.voiceId || null,
    },
  };
  jobs.set(id, job);

  setImmediate(() => {
    runJob(job).catch((e) => {
      job.status = 'failed';
      job.step = 'failed';
      job.error = e.message || 'Pipeline selhala';
      job.updatedAt = new Date().toISOString();
      console.error('[promoVideo]', job.id, e);
    });
  });

  return publicJob(job);
}

async function runJob(job) {
  const patch = (step, extra = {}) => {
    job.step = step;
    job.status = step === 'completed' ? 'completed' : step === 'failed' ? 'failed' : 'running';
    job.progress = STEP_PCT[step] ?? job.progress;
    Object.assign(job, extra);
    job.updatedAt = new Date().toISOString();
  };

  patch('scripting');
  const { script, provider: scriptProvider } = await generatePromoScript(job.input.propertyDetails);
  job.script = script;

  patch('voice');
  const voice = await synthesizePromoVoiceWithTimestamps({
    text: script,
    userId: job.userId,
    voiceId: job.input.voiceId,
  });
  job.audioUrl = voice.audioUrl;
  job.cues = voice.cues;
  job.durationSec = voice.durationSec;

  const droneSeconds = resolveDroneSecondsForBudget({
    droneProvider: process.env.PROMO_DRONE_PROVIDER || 'wan',
    scriptChars: voice.chars || script.length,
  });
  job.costEstimate = estimatePromoCostCzk({
    droneProvider: process.env.PROMO_DRONE_PROVIDER || 'wan',
    droneSeconds,
    scriptChars: voice.chars || script.length,
  });
  job.costActualHint = {
    maxBudgetCzk: PROMO_MAX_COST_CZK,
    estimatedCzk: job.costEstimate.totalCzk,
    withinBudget: job.costEstimate.withinBudget,
    scriptProvider,
    voiceProvider: voice.provider,
  };

  patch('drone');
  const drone = await generateDroneClip({
    exteriorPhotoUrl: job.input.exteriorPhotoUrl,
    aspectRatio: job.aspectRatio,
    scriptChars: voice.chars || script.length,
  });
  job.droneVideoUrl = drone.videoUrl;
  if (drone.skipped) {
    job.costActualHint = {
      ...job.costActualHint,
      droneSkipped: true,
      droneReason: drone.reason || drone.provider,
    };
  }

  const timeline = buildTimeline({
    durationSec: job.durationSec,
    hasDrone: Boolean(drone.videoUrl),
    interiorCount: job.input.interiorPhotoUrls.length,
    cues: job.cues,
    exteriorPhotoUrl: job.input.exteriorPhotoUrl,
    interiorPhotoUrls: job.input.interiorPhotoUrls,
    droneVideoUrl: drone.videoUrl,
  });
  job.timeline = timeline;

  patch('composing');
  const composed = await composePromoKenBurnsMp4({
    droneVideoUrl: drone.videoUrl,
    interiorPhotoUrls: job.input.interiorPhotoUrls,
    audioUrl: voice.audioUrl,
    cues: voice.cues,
    durationSec: job.durationSec,
    aspectRatio: job.aspectRatio,
    userId: job.userId,
    musicUrl: resolveMusicUrl(job.input.musicTrackId),
  });

  patch('completed', {
    videoUrl: composed.videoUrl,
    durationSec: composed.durationSec || job.durationSec,
  });
}

function buildTimeline({
  durationSec,
  hasDrone,
  interiorCount,
  cues,
  exteriorPhotoUrl,
  interiorPhotoUrls,
  droneVideoUrl,
}) {
  const total = Math.max(12, Number(durationSec) || 36);
  const clips = [];
  let t = 0;
  if (hasDrone) {
    const d = Math.min(3.5, Math.max(1.5, total * 0.12));
    clips.push({
      type: 'drone_ai',
      from: t,
      durationInSeconds: d,
      src: droneVideoUrl,
      photoUrl: exteriorPhotoUrl,
    });
    t += d;
  }
  const rem = Math.max(8, total - t);
  const each = rem / Math.max(1, interiorCount);
  for (let i = 0; i < interiorCount; i++) {
    clips.push({
      type: 'ken_burns',
      from: t,
      durationInSeconds: each,
      src: interiorPhotoUrls[i],
      photoUrl: interiorPhotoUrls[i],
      variant: i % 2 === 0 ? 'zoom_in' : 'zoom_out',
    });
    t += each;
  }
  return { totalDurationInSeconds: total, clips, cues: cues || [] };
}
