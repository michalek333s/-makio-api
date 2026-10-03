/**
 * Economy Property Reel — 1× Wan drone (exteriér) + Ken Burns interiéry + titulky.
 * Cíl: ~3–4 kredity / video místo ~11 za full I2V tour.
 */

import { generateDroneClip } from './promoVideo/droneClip.js';
import { composePromoKenBurnsMp4 } from './promoVideo/kenBurnsCompose.js';
import { estimatePromoCostCzk } from './promoVideo/costModel.js';
import { synthesizeReelVoiceover } from './reelTts.js';
import { buildListingSubtitleCues } from './reelCompose.js';
import {
  createVideoJob,
  updateVideoJob,
  getVideoJob,
} from './stagingVideoJobs.js';
import { deductCredits, refundCredits, getEconomyPipelineCreditsBreakdown } from './credits.js';
import { getProviderInfo } from './videoProviders/index.js';
import { toPipelinePublicJob } from './reelPipeline.js';
import { stringifyError } from '../lib/stringifyError.js';

function normalizeAssCues(cues) {
  return (Array.isArray(cues) ? cues : [])
    .map((c) => {
      const text = String(c?.text || '').trim();
      if (!text) return null;
      const start = Number(c.startSec ?? c.start ?? 0) || 0;
      const end = Number(c.endSec ?? c.end ?? start + 2.5) || start + 2.5;
      return { text, start, end, startSec: start, endSec: end };
    })
    .filter(Boolean);
}

/**
 * @param {{
 *  userId: string,
 *  formatId?: string,
 *  imageUrls: string[],
 *  subtitleStyle?: string,
 *  voiceoverScript?: string,
 *  subtitleCues?: object[],
 *  listingDetails?: object,
 *  voiceId?: string,
 * }} input
 */
export async function startEconomyReelPipeline(input) {
  const urls = (input.imageUrls || []).filter((u) => /^https?:\/\//i.test(u));
  if (urls.length < 2) {
    throw Object.assign(
      new Error('Úsporný režim: nahrajte aspoň 2 fotky (1. exteriér + interiéry).'),
      { status: 400, photoCount: { min: 2, max: 8 } },
    );
  }
  if (urls.length > 8) {
    throw Object.assign(new Error('Úsporný režim: maximum 8 fotek.'), {
      status: 400,
      photoCount: { min: 2, max: 8 },
    });
  }

  const exterior = urls[0];
  const interiors = urls.slice(1);
  const withVoice = Boolean(String(input.voiceoverScript || '').trim());
  const breakdown = getEconomyPipelineCreditsBreakdown({ withVoice });
  const cost = breakdown.total;
  const idempotencyKey = `economy-${input.userId}-${Date.now()}-${urls.length}`;

  const afterDeduct = await deductCredits(input.userId, cost, {
    sourceRef: 'ai_reel_economy',
    idempotencyKey,
    metadata: { formatId: input.formatId, breakdown, mode: 'economy' },
  });

  const providerInfo = getProviderInfo();
  let job;
  try {
    job = await createVideoJob({
      userId: input.userId,
      sourceImageUrl: exterior,
      cameraPreset: 'drone_in',
      status: 'queued',
      provider: providerInfo.provider,
      providerJobId: null,
      creditsDeducted: cost,
      metadata: {
        product: 'ai_reel_pipeline',
        mode: 'economy',
        pipelineStep: 'queued',
        formatId: input.formatId || 'standard_tour',
        subtitleStyle: input.subtitleStyle || 'hormozi',
        listingDetails: input.listingDetails || {},
        voiceoverScript: input.voiceoverScript || '',
        subtitleCues: Array.isArray(input.subtitleCues) ? input.subtitleCues : [],
        voiceId: input.voiceId || null,
        sourceImageUrls: urls,
        exteriorPhotoUrl: exterior,
        interiorPhotoUrls: interiors,
        segments: [],
        playlistUrls: [],
        finalVideoUrl: null,
        audioUrl: null,
        creditBreakdown: breakdown,
        costEstimateCzk: estimatePromoCostCzk({ scriptChars: 380 }).totalCzk,
        idempotencyKey,
        provider: providerInfo.provider,
        demo: providerInfo.provider === 'mock',
      },
    });
  } catch (err) {
    await refundCredits(input.userId, cost, {
      sourceRef: 'ai_reel_refund',
      idempotencyKey: `refund-create-${idempotencyKey}`,
      metadata: { reason: stringifyError(err) },
    });
    throw err;
  }

  setImmediate(() => {
    runEconomyReelPipeline(job.id, input.userId).catch((e) => {
      console.error('[economyReel]', job.id, stringifyError(e));
    });
  });

  return {
    job: toPipelinePublicJob(job),
    credits: afterDeduct.balance,
    requiredCredits: cost,
    breakdown,
    provider: { ...providerInfo, label: `${providerInfo.label} · economy` },
    mode: 'economy',
    steps: ['drone', 'voice', 'kenburns', 'composing'],
  };
}

export async function runEconomyReelPipeline(jobId, userId) {
  const job = await getVideoJob(jobId, userId);
  if (!job) return;

  const meta = { ...(job.metadata || {}) };
  const exterior = meta.exteriorPhotoUrl || meta.sourceImageUrls?.[0];
  let interiors = Array.isArray(meta.interiorPhotoUrls)
    ? [...meta.interiorPhotoUrls]
    : (meta.sourceImageUrls || []).slice(1);

  try {
    await patchStep(jobId, 'drone', meta);

    let droneVideoUrl = null;
    let droneMeta = { skipped: false };
    try {
      const drone = await generateDroneClip({
        exteriorPhotoUrl: exterior,
        aspectRatio: '9:16',
        scriptChars: String(meta.voiceoverScript || '').length || 320,
      });
      droneVideoUrl = drone.videoUrl || null;
      droneMeta = {
        skipped: Boolean(drone.skipped),
        reason: drone.reason || null,
        provider: drone.provider,
        seconds: drone.seconds,
      };
      if (drone.providerJobId) {
        meta.segments = [
          {
            index: 0,
            type: 'drone',
            imageUrl: exterior,
            providerJobId: drone.providerJobId,
            provider: drone.provider,
            status: droneVideoUrl ? 'completed' : 'skipped',
            videoUrl: droneVideoUrl,
            preset: 'drone_in',
            label: 'Exterior drone',
          },
        ];
      }
    } catch (droneErr) {
      console.warn('[economyReel] drone soft-fail → Ken Burns only', stringifyError(droneErr));
      droneMeta = { skipped: true, reason: stringifyError(droneErr), softFail: true };
      // Exterior as first Ken Burns still
      if (exterior && !interiors.includes(exterior)) {
        interiors.unshift(exterior);
      }
    }
    meta.droneVideoUrl = droneVideoUrl;
    meta.droneMeta = droneMeta;
    await patchStep(jobId, 'voice', meta);

    const script = String(meta.voiceoverScript || '').trim();
    const tts = await synthesizeReelVoiceover({
      text: script,
      userId,
      voiceId: meta.voiceId || undefined,
    });
    meta.audioUrl = tts.audioUrl;
    meta.ttsProvider = tts.provider;
    meta.ttsSkipped = Boolean(tts.skipped);

    const listingCues = buildListingSubtitleCues(meta.listingDetails || {}, Math.max(2, interiors.length + 1));
    const cues = normalizeAssCues(
      (Array.isArray(meta.subtitleCues) && meta.subtitleCues.length
        ? meta.subtitleCues
        : listingCues),
    );
    meta.subtitleCues = cues;

    const durationSec = Math.max(
      14,
      Number(tts.durationHintSec) || 8 + interiors.length * 3.5 + (droneVideoUrl ? 2.5 : 0),
    );

    await patchStep(jobId, 'composing', meta);
    const composed = await composePromoKenBurnsMp4({
      droneVideoUrl,
      interiorPhotoUrls: interiors.length ? interiors : [exterior],
      audioUrl: tts.audioUrl,
      cues,
      durationSec,
      aspectRatio: '9:16',
      userId,
      musicUrl: null,
    });

    meta.finalVideoUrl = composed.videoUrl;
    meta.composed = true;
    meta.composeReason = composed.engine || 'ffmpeg_kenburns';
    meta.playlistUrls = composed.videoUrl ? [composed.videoUrl] : [];
    meta.durationSec = composed.durationSec || durationSec;

    await updateVideoJob(jobId, {
      status: 'completed',
      video_url: composed.videoUrl || null,
      metadata: {
        ...meta,
        pipelineStep: 'completed',
      },
    });
  } catch (err) {
    const errMsg = stringifyError(err, 'Economy pipeline selhala.');
    console.error('[economyReel]', jobId, errMsg);
    const latest = await getVideoJob(jobId, userId);
    const cost = latest?.credits_deducted || 0;
    await updateVideoJob(jobId, {
      status: 'failed',
      error: errMsg,
      metadata: {
        ...(latest?.metadata || meta),
        pipelineStep: 'failed',
        failReason: errMsg,
      },
    });
    if (cost > 0) {
      try {
        await refundCredits(userId, cost, {
          sourceRef: 'ai_reel_refund',
          idempotencyKey: `refund-econ-${jobId}`,
          metadata: { reason: errMsg },
        });
        await updateVideoJob(jobId, { status: 'refunded', error: errMsg });
      } catch (e) {
        console.error('[economyReel] refund failed', stringifyError(e));
      }
    }
  }
}

async function patchStep(jobId, step, meta) {
  meta.pipelineStep = step;
  await updateVideoJob(jobId, {
    status: 'processing',
    metadata: { ...meta },
  });
}
