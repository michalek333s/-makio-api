/**
 * Makio Reels full pipeline:
 * staging (Decor8) → directing → i2v → voice (TTS) → compose (FFmpeg) → final MP4
 */

import { generateDecor8Staging, isDecor8Configured } from './decor8Staging.js';
import { generateDirectorPrompt } from './reelDirector.js';
import { buildPropertyTourPrompt } from './propertyTourPrompt.js';
import { startI2V, pollI2V, getConfiguredProviderId, getProviderInfo } from './videoProviders/index.js';
import { synthesizeReelVoiceover } from './reelTts.js';
import { composeReelMp4 } from './reelCompose.js';
import {
  createVideoJob,
  updateVideoJob,
  getVideoJob,
  toPublicJob,
} from './stagingVideoJobs.js';
import {
  deductCredits,
  refundCredits,
  getPipelineCreditsBreakdown,
} from './credits.js';
import { getStudioFormat, motionForClip } from '../config/reelFormats.js';
import { stringifyError } from '../lib/stringifyError.js';

const ROOM_HINTS = {
  0: 'exterior',
  1: 'livingroom',
  2: 'kitchen',
  3: 'bedroom',
  4: 'bathroom',
  5: 'diningroom',
  6: 'office',
  7: 'livingroom',
};

const STEP_PROGRESS = {
  queued: 5,
  staging: 15,
  directing: 25,
  drone: 35,
  rendering: 55,
  voice: 70,
  kenburns: 80,
  composing: 90,
  completed: 100,
  failed: 0,
  refunded: 0,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {{
 *  userId: string,
 *  formatId: string,
 *  imageUrls: string[],
 *  stagingEnabled?: boolean,
 *  designStyle?: string,
 *  roomTypes?: string[],
 *  subtitleStyle?: string,
 *  voiceoverScript?: string,
 *  subtitleCues?: object[],
 *  listingDetails?: object,
 *  voiceId?: string,
 * }} input
 */
export async function startReelPipeline(input) {
  const format = getStudioFormat(input.formatId);
  if (!format) {
    throw Object.assign(new Error('Neplatný formát.'), { status: 400 });
  }
  const imageUrls = (input.imageUrls || []).filter((u) => /^https?:\/\//i.test(u));
  const n = imageUrls.length;
  if (n < format.photoCount.min || n > format.photoCount.max) {
    throw Object.assign(
      new Error(`${format.title}: potřebujete ${format.photoCount.min}–${format.photoCount.max} fotek (máte ${n}).`),
      { status: 400, photoCount: format.photoCount },
    );
  }

  const stagingEnabled = input.stagingEnabled !== false && isDecor8Configured();
  const withVoice = Boolean(String(input.voiceoverScript || '').trim());
  const breakdown = getPipelineCreditsBreakdown({
    imageCount: n,
    stagingEnabled,
    withVoice,
    withCompose: true,
  });
  const cost = breakdown.total;
  const idempotencyKey = `pipeline-${input.userId}-${Date.now()}-${input.formatId}-${n}`;

  const afterDeduct = await deductCredits(input.userId, cost, {
    sourceRef: 'ai_reel_pipeline',
    idempotencyKey,
    metadata: { formatId: input.formatId, breakdown },
  });

  const providerInfo = getProviderInfo();
  let job;
  try {
    job = await createVideoJob({
      userId: input.userId,
      sourceImageUrl: imageUrls[0],
      cameraPreset: motionForClip(format, 0) || 'dolly_in',
      status: 'queued',
      provider: providerInfo.provider,
      providerJobId: null,
      creditsDeducted: cost,
      metadata: {
        product: 'ai_reel_pipeline',
        pipelineStep: 'queued',
        formatId: input.formatId,
        subtitleStyle: input.subtitleStyle || 'hormozi',
        listingDetails: input.listingDetails || {},
        voiceoverScript: input.voiceoverScript || '',
        subtitleCues: Array.isArray(input.subtitleCues) ? input.subtitleCues : [],
        voiceId: input.voiceId || null,
        stagingEnabled,
        designStyle: input.designStyle || 'modern',
        roomTypes: input.roomTypes || [],
        sourceImageUrls: imageUrls,
        stagedImageUrls: null,
        segments: [],
        playlistUrls: [],
        finalVideoUrl: null,
        audioUrl: null,
        creditBreakdown: breakdown,
        idempotencyKey,
        provider: providerInfo.provider,
        demo: providerInfo.provider === 'mock',
      },
    });
  } catch (err) {
    await refundCredits(input.userId, cost, {
      sourceRef: 'ai_reel_refund',
      idempotencyKey: `refund-create-${idempotencyKey}`,
      metadata: { reason: err.message },
    });
    throw err;
  }

  // Fire-and-forget background runner
  setImmediate(() => {
    runReelPipeline(job.id, input.userId).catch((e) => {
      console.error('[reelPipeline] fatal', job.id, e.message);
    });
  });

  return {
    job: toPipelinePublicJob(job),
    credits: afterDeduct.balance,
    requiredCredits: cost,
    breakdown,
    provider: providerInfo,
    steps: ['staging', 'directing', 'rendering', 'voice', 'composing'],
  };
}

export async function runReelPipeline(jobId, userId) {
  const job = await getVideoJob(jobId, userId);
  if (!job) return;

  const meta = { ...(job.metadata || {}) };
  const sourceUrls = Array.isArray(meta.sourceImageUrls) ? meta.sourceImageUrls : [];
  const format = getStudioFormat(meta.formatId);

  try {
    // 1) Staging
    await patchStep(jobId, 'staging', meta);
    let workUrls = [...sourceUrls];
    if (meta.stagingEnabled && isDecor8Configured()) {
      const staged = [];
      for (let i = 0; i < sourceUrls.length; i += 1) {
        const roomType =
          (Array.isArray(meta.roomTypes) && meta.roomTypes[i]) || ROOM_HINTS[i] || 'livingroom';
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await generateDecor8Staging({
            imageUrl: sourceUrls[i],
            roomType,
            designStyle: meta.designStyle || 'modern',
            numImages: 1,
          });
          staged.push(result.urls[0] || sourceUrls[i]);
        } catch (err) {
          console.warn('[reelPipeline] staging fallback', i, err.message);
          staged.push(sourceUrls[i]);
        }
      }
      workUrls = staged;
      meta.stagedImageUrls = staged;
    } else {
      meta.stagedImageUrls = sourceUrls;
      meta.stagingSkipped = !meta.stagingEnabled || !isDecor8Configured();
    }

    // 2) Directing + 3) start I2V
    await patchStep(jobId, 'directing', meta);
    const segments = [];
    const roomTypes = Array.isArray(meta.roomTypes) ? meta.roomTypes : [];
    for (let i = 0; i < workUrls.length; i += 1) {
      const preset = motionForClip(format || { id: meta.formatId }, i) || 'dolly_in';
      const roomApi = roomTypes[i] || ROOM_HINTS[i] || 'livingroom';
      const roomLabel =
        roomApi === 'kitchen'
          ? 'Kitchen'
          : roomApi === 'bedroom'
            ? 'Bedroom'
            : roomApi === 'bathroom'
              ? 'Bathroom'
              : roomApi === 'diningroom'
                ? 'Dining room'
                : roomApi === 'office'
                  ? 'Home office'
                  : roomApi === 'exterior' || preset === 'drone_in'
                    ? 'Exterior facade'
                    : 'Living room';

      let cameraPrompt;
      try {
        if (process.env.REEL_DIRECTOR_CLAUDE === '1') {
          // eslint-disable-next-line no-await-in-loop
          const director = await generateDirectorPrompt({
            preset,
            roomType: roomLabel,
            style: [meta.designStyle, meta.listingDetails?.disposition].filter(Boolean).join(' '),
            imageUrl: workUrls[i],
          });
          cameraPrompt = director.cameraPrompt;
        } else {
          cameraPrompt = buildPropertyTourPrompt({
            preset,
            roomLabel,
            index: i,
            total: workUrls.length,
            listingTitle: meta.listingDetails?.title,
          });
        }
      } catch {
        cameraPrompt = buildPropertyTourPrompt({
          preset,
          roomLabel,
          index: i,
          total: workUrls.length,
        });
      }

      let started;
      try {
        // eslint-disable-next-line no-await-in-loop
        started = await startI2V({
          imageUrl: workUrls[i],
          cameraPresetId: preset,
          cameraPrompt,
          aspectRatio: '9:16',
        });
      } catch (startErr) {
        console.warn('[reelPipeline] i2v start retry', i, stringifyError(startErr));
        // eslint-disable-next-line no-await-in-loop
        await sleep(1500);
        // eslint-disable-next-line no-await-in-loop
        started = await startI2V({
          imageUrl: workUrls[i],
          cameraPresetId: preset === 'drone_in' ? 'crane_up' : preset,
          cameraPrompt,
          aspectRatio: '9:16',
        });
      }

      segments.push({
        index: i,
        imageUrl: workUrls[i],
        providerJobId: started.providerJobId,
        statusUrl: started.statusUrl,
        responseUrl: started.responseUrl || null,
        provider: started.provider,
        status: 'processing',
        videoUrl: null,
        cameraPrompt,
        preset,
        roomType: roomApi,
        label: roomLabel,
      });
    }
    meta.segments = segments;
    meta.provider = getConfiguredProviderId();
    meta.demo = segments.some((s) => String(s.providerJobId || '').startsWith('mock-'));
    await patchStep(jobId, 'rendering', meta, {
      provider: meta.provider,
      provider_job_id: segments[0]?.providerJobId || null,
      provider_status_url: segments[0]?.statusUrl || null,
    });

    // Poll all segments
    const clipUrls = await waitForSegments(jobId, userId, meta);
    meta.playlistUrls = clipUrls;

    // 4) Voice
    await patchStep(jobId, 'voice', meta);
    const tts = await synthesizeReelVoiceover({
      text: meta.voiceoverScript || '',
      userId,
      voiceId: meta.voiceId || undefined,
    });
    meta.audioUrl = tts.audioUrl;
    meta.ttsProvider = tts.provider;
    meta.ttsSkipped = Boolean(tts.skipped);

    // 5) Compose
    await patchStep(jobId, 'composing', meta);
    const composed = await composeReelMp4({
      clipUrls,
      audioUrl: tts.audioUrl,
      subtitleCues: meta.subtitleCues || [],
      subtitleStyle: meta.subtitleStyle || 'hormozi',
      listingDetails: meta.listingDetails || {},
      userId,
    });
    meta.finalVideoUrl = composed.finalVideoUrl;
    meta.composed = composed.composed;
    meta.composeReason = composed.reason || null;
    const playlistUrls = Array.isArray(composed.playlistUrls) && composed.playlistUrls.length
      ? composed.playlistUrls
      : clipUrls;

    await updateVideoJob(jobId, {
      status: 'completed',
      // Prefer composed final; if concat failed, leave null so FE uses full playlist
      video_url: composed.finalVideoUrl || null,
      metadata: {
        ...meta,
        pipelineStep: 'completed',
        playlistUrls,
      },
    });
  } catch (err) {
    const errMsg = stringifyError(err, 'Pipeline selhala.');
    console.error('[reelPipeline]', jobId, errMsg);
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
          idempotencyKey: `refund-pipe-${jobId}`,
          metadata: { reason: errMsg },
        });
        await updateVideoJob(jobId, { status: 'refunded', error: errMsg });
      } catch (e) {
        console.error('[reelPipeline] refund failed', stringifyError(e));
      }
    }
  }
}

async function patchStep(jobId, step, meta, extra = {}) {
  meta.pipelineStep = step;
  await updateVideoJob(jobId, {
    status: step === 'completed' ? 'completed' : 'processing',
    metadata: { ...meta },
    ...extra,
  });
}

async function waitForSegments(jobId, userId, meta) {
  const maxTries = 90;
  for (let tryN = 0; tryN < maxTries; tryN += 1) {
    let segments = Array.isArray(meta.segments) ? [...meta.segments] : [];
    let failed = null;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (seg.status === 'completed' && seg.videoUrl) continue;
      // eslint-disable-next-line no-await-in-loop
      const poll = await pollI2V(seg.providerJobId, seg.statusUrl, seg.provider);
      if (poll.status === 'completed' && poll.videoUrl) {
        segments[i] = { ...seg, status: 'completed', videoUrl: poll.videoUrl };
      } else if (poll.status === 'failed') {
        failed = poll.error || 'Segment failed';
        segments[i] = { ...seg, status: 'failed', error: failed };
        break;
      } else {
        segments[i] = {
          ...seg,
          status: poll.status === 'queued' ? 'queued' : 'processing',
        };
      }
    }
    meta.segments = segments;
    const done = segments.filter((s) => s.status === 'completed' && s.videoUrl).length;
    await updateVideoJob(jobId, {
      status: 'processing',
      metadata: { ...meta, pipelineStep: 'rendering', renderProgress: done },
      video_url: segments.find((s) => s.videoUrl)?.videoUrl || null,
    });

    if (failed) {
      throw Object.assign(new Error(stringifyError(failed, 'Segment failed')), { status: 422 });
    }
    if (done === segments.length) {
      return segments.map((s) => s.videoUrl);
    }
    await sleep(2000);
  }
  throw Object.assign(new Error('Vypršel čas čekání na video klipy.'), { status: 504 });
}

export function toPipelinePublicJob(job) {
  if (!job) return null;
  const base = toPublicJob(job);
  const meta = job.metadata || {};
  const step = meta.pipelineStep || job.status;
  const segments = Array.isArray(meta.segments) ? meta.segments : [];
  const clipsDone = segments.filter((s) => s.status === 'completed' && s.videoUrl).length;
  const clipsTotal = segments.length || base.segmentCount || 1;
  let progress = STEP_PROGRESS[step] ?? 40;
  if (step === 'rendering' && clipsTotal > 0) {
    progress = 25 + Math.round((clipsDone / clipsTotal) * 45);
  }
  return {
    ...base,
    step,
    progress,
    mode: meta.mode || 'cinematic',
    stagedUrls: meta.stagedImageUrls || null,
    playlistUrls: meta.playlistUrls?.length
      ? meta.playlistUrls
      : base.playlistUrls || [],
    finalVideoUrl: meta.composed
      ? meta.finalVideoUrl || base.videoUrl || null
      : meta.finalVideoUrl || null,
    videoUrl: meta.composed
      ? meta.finalVideoUrl || base.videoUrl || null
      : meta.finalVideoUrl || (meta.playlistUrls?.[0] ?? base.videoUrl) || null,
    stagingEnabled: Boolean(meta.stagingEnabled),
    creditBreakdown: meta.creditBreakdown || null,
    provider: meta.provider || job.provider,
    composed: Boolean(meta.composed),
    composeReason: meta.composeReason || null,
    ttsProvider: meta.ttsProvider || null,
    clipsDone,
    clipsTotal,
  };
}

export async function getPipelineJobStatus(jobId, userId) {
  const job = await getVideoJob(jobId, userId);
  if (!job) return null;

  const meta = job.metadata || {};
  const pub = toPipelinePublicJob(job);

  return {
    job: pub,
    progress: pub.progress,
    step: meta.pipelineStep || job.status,
    message:
      meta.pipelineStep === 'rendering' && pub.clipsTotal
        ? `Generuji video klipy… ${pub.clipsDone}/${pub.clipsTotal}`
        : stepMessage(meta.pipelineStep || job.status),
  };
}

function stepMessage(step) {
  const map = {
    queued: 'Pipeline připravena…',
    staging: 'Přeskakuji staging (jen video)…',
    directing: 'Připravuji pohyby kamery…',
    drone: 'Generuji drone záběr z exteriéru…',
    rendering: 'Generuji video klipy…',
    voice: 'Syntetizuji voiceover / titulky…',
    kenburns: 'Skládám Ken Burns prohlídku…',
    composing: 'Skládám finální Instagram MP4…',
    completed: 'Hotovo',
    failed: 'Selhalo',
    refunded: 'Kredity vráceny',
  };
  return map[step] || 'Zpracovávám…';
}
