/**
 * AI Reel Generator — Tvorba propagace
 * POST /api/reels/generate  (1–N fotek → home tour)
 * GET  /api/reels/generate/:jobId
 */

import { Router } from 'express';
import multer from 'multer';
import { generateDirectorPrompt, REEL_PRESET_IDS } from '../services/reelDirector.js';
import {
  uploadReelSourceImage,
  MAX_REEL_IMAGES,
} from '../services/reelImageUpload.js';
import {
  getCameraPreset,
  CAMERA_PRESETS,
} from '../services/higgsfieldVideo.js';
import {
  startI2V,
  pollI2V,
  getProviderInfo,
} from '../services/videoProviders/index.js';
import {
  createVideoJob,
  updateVideoJob,
  getVideoJob,
  toPublicJob,
} from '../services/stagingVideoJobs.js';
import {
  getCreditsBalance,
  deductCredits,
  refundCredits,
  grantCredits,
  getRequiredVideoCredits,
  getCreditPriceLabel,
  getCreditsPerClip,
  getCreditUnitPriceCzk,
} from '../services/credits.js';

const router = Router();
const REEL_PRESETS = REEL_PRESET_IDS;
const MAX_FILES = Math.max(1, Math.min(Number(MAX_REEL_IMAGES) || 8, 12));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.REEL_UPLOAD_MAX_BYTES || 12 * 1024 * 1024),
    files: MAX_FILES,
  },
  fileFilter(_req, file, cb) {
    const ok = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.mimetype || '');
    cb(ok ? null : new Error('Povolené formáty: JPG, PNG, WebP, HEIC.'), ok);
  },
});

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.fields([
      { name: 'images', maxCount: MAX_FILES },
      { name: 'image', maxCount: 1 },
    ])(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

function collectUploadedFiles(req) {
  const fromMulti = Array.isArray(req.files?.images) ? req.files.images : [];
  const fromSingle = Array.isArray(req.files?.image) ? req.files.image : [];
  return [...fromMulti, ...fromSingle].slice(0, MAX_FILES);
}

function requireUser(req, res) {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Přihlášení vyžadováno.', code: 'AUTH_REQUIRED' });
    return null;
  }
  return req.user;
}

function parseImageUrlsBody(body) {
  const raw = body?.imageUrls || body?.imageUrl || body?.sourceImageUrl || '';
  if (Array.isArray(raw)) {
    return raw.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u));
  }
  const s = String(raw || '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        return arr.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u));
      }
    } catch {
      /* ignore */
    }
  }
  return /^https?:\/\//i.test(s) ? [s] : [];
}

router.get('/presets', (_req, res) => {
  res.json({
    presets: REEL_PRESETS.map((id) => {
      const p = CAMERA_PRESETS[id];
      return { id, label: p.label, emoji: p.emoji };
    }),
    priceLabel: getCreditPriceLabel(1),
    creditsPerClip: getCreditsPerClip(),
    requiredCredits: getRequiredVideoCredits(1),
    maxImages: MAX_FILES,
    providerReady: getProviderInfo().provider !== 'mock' || process.env.NODE_ENV !== 'production',
    provider: getProviderInfo(),
  });
});

router.get('/credits', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const bal = await getCreditsBalance(user.id);
    res.json({
      ...bal,
      priceLabel: getCreditPriceLabel(1),
      creditsPerClip: getCreditsPerClip(),
      unitPriceCzk: getCreditUnitPriceCzk(),
      maxImages: MAX_FILES,
      topupHint:
        'Online platba kreditů přijde brzy. Mezitím napište na info@makio.cz — po převodu vám kredity dobijeme ručně.',
    });
  } catch (err) {
    const status = Number(err.status) >= 400 && Number(err.status) < 600 ? err.status : 500;
    res.status(status).json({ error: err.message, code: err.code || undefined });
  }
});

/**
 * Manuální dobití kreditů.
 * - Produkce: hlavička X-Credits-Admin-Secret = CREDITS_ADMIN_SECRET
 * - Dev: CREDITS_ALLOW_SELF_TOPUP=1 → přihlášený uživatel si může dobít max 50 kr
 */
router.post('/credits/topup', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const adminSecret = String(process.env.CREDITS_ADMIN_SECRET || '').trim();
  const provided = String(req.get('x-credits-admin-secret') || req.body?.adminSecret || '').trim();
  const isAdmin = Boolean(adminSecret && provided && provided === adminSecret);
  const selfOk =
    process.env.NODE_ENV !== 'production' &&
    (process.env.CREDITS_ALLOW_SELF_TOPUP === '1' || process.env.CREDITS_ALLOW_SELF_TOPUP === 'true');

  if (!isAdmin && !selfOk) {
    return res.status(403).json({
      error:
        'Dobití kreditů zatím není self-serve. Napište na info@makio.cz, nebo nastavte CREDITS_ADMIN_SECRET pro manuální top-up.',
      code: 'TOPUP_FORBIDDEN',
    });
  }

  let amount = Math.floor(Number(req.body?.amount));
  if (!Number.isFinite(amount) || amount < 1) {
    return res.status(400).json({ error: 'Zadejte amount (počet kreditů).' });
  }
  if (!isAdmin) amount = Math.min(amount, 50);

  const targetUserId = isAdmin && req.body?.userId ? String(req.body.userId) : user.id;

  try {
    const result = await grantCredits(targetUserId, amount, {
      sourceRef: isAdmin ? 'admin_topup' : 'dev_self_topup',
      metadata: {
        by: user.id,
        admin: isAdmin,
        note: String(req.body?.note || '').slice(0, 200),
      },
    });
    res.json({
      ok: true,
      ...result,
      message: `Připsáno ${result.granted} kreditů. Nový zůstatek: ${result.balance}.`,
    });
  } catch (err) {
    const status = Number(err.status) >= 400 && Number(err.status) < 600 ? err.status : 500;
    res.status(status).json({ error: err.message, code: err.code || undefined });
  }
});

router.post('/generate', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  try {
    await runUpload(req, res);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Neplatný upload fotky.' });
  }

  const preset = String(req.body?.preset || '').trim();
  const roomType = String(req.body?.roomType || 'Living Room').trim() || 'Living Room';
  const style = String(req.body?.style || '').trim();
  const files = collectUploadedFiles(req);

  if (!REEL_PRESETS.includes(preset) || !getCameraPreset(preset)) {
    return res.status(400).json({ error: 'Neplatný preset.', presets: REEL_PRESETS });
  }

  /** @type {string[]} */
  let imageUrls = [];

  if (files.length) {
    if (files.length > MAX_FILES) {
      return res.status(400).json({
        error: `Maximum je ${MAX_FILES} fotek na tour celého bytu/domu.`,
        maxImages: MAX_FILES,
      });
    }
    try {
      for (const file of files) {
        // sequential to avoid storage rate limits
        // eslint-disable-next-line no-await-in-loop
        const uploaded = await uploadReelSourceImage(file, user.id);
        imageUrls.push(uploaded.publicUrl);
      }
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Upload fotky selhal.' });
    }
  } else {
    imageUrls = parseImageUrlsBody(req.body).slice(0, MAX_FILES);
  }

  if (!imageUrls.length) {
    return res.status(400).json({
      error: `Nahrajte 1–${MAX_FILES} fotek (pole images), nebo pošlete https imageUrls.`,
      maxImages: MAX_FILES,
    });
  }

  const segmentCount = imageUrls.length;
  const cost = getRequiredVideoCredits(segmentCount);
  const idempotencyKey = `reel-${user.id}-${Date.now()}-${preset}-${segmentCount}`;
  let deducted = false;
  const tourRoomType =
    segmentCount > 1
      ? String(req.body?.roomType || 'Home Tour').trim() || 'Home Tour'
      : roomType;

  try {
    const afterDeduct = await deductCredits(user.id, cost, {
      sourceRef: 'ai_reel',
      idempotencyKey,
      metadata: { preset, roomType: tourRoomType, segmentCount },
    });
    deducted = true;

    /** @type {object[]} */
    const segments = [];
    let anyDemo = false;

    for (let i = 0; i < imageUrls.length; i += 1) {
      const imageUrl = imageUrls[i];
      const clipRoom =
        segmentCount > 1 ? `Room ${i + 1} of home tour (${tourRoomType})` : tourRoomType;

      // eslint-disable-next-line no-await-in-loop
      const director = await generateDirectorPrompt({
        preset,
        roomType: clipRoom,
        style,
        imageUrl,
      });

      let provider;
      try {
        // eslint-disable-next-line no-await-in-loop
        provider = await startI2V({
          imageUrl,
          cameraPresetId: preset,
          cameraPrompt: director.cameraPrompt,
        });
      } catch (providerErr) {
        await refundCredits(user.id, cost, {
          sourceRef: 'ai_reel_refund',
          idempotencyKey: `refund-${idempotencyKey}`,
          metadata: { reason: providerErr.message, failedAtSegment: i },
        });
        deducted = false;
        throw providerErr;
      }

      anyDemo = anyDemo || Boolean(provider.demo);
      segments.push({
        index: i,
        imageUrl,
        providerJobId: provider.providerJobId,
        statusUrl: provider.statusUrl,
        status: 'processing',
        videoUrl: null,
        cameraPrompt: director.cameraPrompt,
        shotNotes: director.shotNotes,
        usedFallback: director.usedFallback,
        estimatedStabilityScore: director.estimatedStabilityScore,
      });
    }

    const job = await createVideoJob({
      userId: user.id,
      sourceImageUrl: imageUrls[0],
      cameraPreset: preset,
      status: 'processing',
      provider: segments[0]?.providerJobId?.startsWith('mock-') ? 'mock' : 'higgsfield',
      providerJobId: segments[0].providerJobId,
      providerStatusUrl: segments[0].statusUrl,
      creditsDeducted: cost,
      metadata: {
        demo: anyDemo,
        roomType: tourRoomType,
        style: style || null,
        segmentCount,
        sourceImageUrls: imageUrls,
        segments,
        directorPrompt: segments[0]?.cameraPrompt,
        shotNotes:
          segmentCount > 1
            ? `Home tour · ${segmentCount} místností · ${preset}`
            : segments[0]?.shotNotes,
        directorFallback: segments.some((s) => s.usedFallback),
        masterVersion: '3.0.0',
        estimatedStabilityScore: segments[0]?.estimatedStabilityScore || '0.98',
        idempotencyKey,
        product: segmentCount > 1 ? 'ai_reel_tour' : 'ai_reel',
      },
    });

    res.status(202).json({
      job: toPublicJob(job),
      director: {
        cameraPrompt: segments[0]?.cameraPrompt,
        presetApplied: preset,
        estimatedStabilityScore: segments[0]?.estimatedStabilityScore || '0.98',
        shotNotes:
          segmentCount > 1
            ? `Tour celého bytu/domu: ${segmentCount} × 5 s klipů.`
            : segments[0]?.shotNotes,
        usedFallback: segments.some((s) => s.usedFallback),
        masterVersion: '3.0.0',
        segmentCount,
      },
      credits: afterDeduct.balance,
      requiredCredits: cost,
      priceLabel: getCreditPriceLabel(segmentCount),
      steps:
        segmentCount > 1
          ? [
              `Claude připravuje scénáře pro ${segmentCount} místností...`,
              'Higgsfield skládá tour video bytu/domu...',
            ]
          : [
              'Claude připravuje scénář pohybu...',
              'Higgsfield AI vykresluje 3D video...',
            ],
    });
  } catch (err) {
    if (deducted) {
      try {
        await refundCredits(user.id, cost, {
          sourceRef: 'ai_reel_refund',
          idempotencyKey: `refund-err-${idempotencyKey}`,
          metadata: { reason: err.message },
        });
      } catch (e) {
        console.error('[reels] refund failed', e.message);
      }
    }
    res.status(err.status || 500).json({
      error: err.message || 'Generování reelů selhalo.',
      code: err.code,
      requiredCredits: cost,
    });
  }
});

router.get('/generate/:jobId', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const job = await getVideoJob(String(req.params.jobId || ''), user.id);
  if (!job) return res.status(404).json({ error: 'Job nenalezen.' });

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'refunded') {
    return res.json({
      job: toPublicJob(job),
      director: {
        shotNotes: job.metadata?.shotNotes,
        cameraPrompt: job.metadata?.directorPrompt,
      },
    });
  }

  try {
    const meta = { ...(job.metadata || {}) };
    let segments = Array.isArray(meta.segments) ? [...meta.segments] : null;

    // Legacy single-clip jobs
    if (!segments?.length) {
      const poll = await pollI2V(job.provider_job_id, job.provider_status_url, job.provider);
      if (poll.status === 'completed' && poll.videoUrl) {
        const updated = await updateVideoJob(job.id, {
          status: 'completed',
          video_url: poll.videoUrl,
          metadata: { ...meta, demo: Boolean(poll.demo) },
        });
        return res.json({
          job: toPublicJob(updated || { ...job, status: 'completed', video_url: poll.videoUrl }),
          progress: 100,
          step: 2,
        });
      }
      if (poll.status === 'failed') {
        await failAndRefund(job, user.id, poll.error || 'failed');
        return res.status(422).json({
          error: poll.error || 'Generování selhalo, kredity vráceny.',
          job: toPublicJob({ ...job, status: 'refunded', error: poll.error }),
        });
      }
      const nextStatus = poll.status === 'queued' ? 'queued' : 'processing';
      await updateVideoJob(job.id, { status: nextStatus });
      return res.json({
        job: toPublicJob({ ...job, status: nextStatus }),
        progress: poll.progress ?? 55,
        step: 2,
      });
    }

    // Multi-segment home tour
    let failed = null;
    let demo = Boolean(meta.demo);
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (seg.status === 'completed' && seg.videoUrl) continue;
      if (seg.status === 'failed') {
        failed = seg.error || 'Segment failed';
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      const poll = await pollI2V(seg.providerJobId, seg.statusUrl, seg.provider || job.provider);
      if (poll.status === 'completed' && poll.videoUrl) {
        segments[i] = {
          ...seg,
          status: 'completed',
          videoUrl: poll.videoUrl,
        };
        demo = demo || Boolean(poll.demo);
      } else if (poll.status === 'failed') {
        segments[i] = { ...seg, status: 'failed', error: poll.error || 'failed' };
        failed = poll.error || 'failed';
        break;
      } else {
        segments[i] = { ...seg, status: poll.status === 'queued' ? 'queued' : 'processing' };
      }
    }

    const done = segments.filter((s) => s.status === 'completed' && s.videoUrl).length;
    const total = segments.length;
    const progress = Math.round((done / total) * 100);

    if (failed) {
      await updateVideoJob(job.id, {
        status: 'failed',
        error: failed,
        metadata: { ...meta, segments, demo },
      });
      await refundCredits(user.id, job.credits_deducted, {
        sourceRef: 'ai_reel_refund',
        idempotencyKey: `refund-fail-${job.id}`,
        metadata: { reason: failed },
      });
      await updateVideoJob(job.id, {
        status: 'refunded',
        error: failed,
        metadata: { ...meta, segments, demo },
      });
      return res.status(422).json({
        error: failed || 'Generování selhalo, kredity vráceny.',
        job: toPublicJob({ ...job, status: 'refunded', error: failed, metadata: { ...meta, segments } }),
      });
    }

    if (done === total) {
      const playlist = segments.map((s) => s.videoUrl);
      const updated = await updateVideoJob(job.id, {
        status: 'completed',
        video_url: playlist[0],
        metadata: {
          ...meta,
          segments,
          demo,
          playlistUrls: playlist,
        },
      });
      return res.json({
        job: toPublicJob(
          updated || {
            ...job,
            status: 'completed',
            video_url: playlist[0],
            metadata: { ...meta, segments, playlistUrls: playlist, demo },
          },
        ),
        progress: 100,
        step: 2,
        segmentsDone: done,
        segmentCount: total,
      });
    }

    await updateVideoJob(job.id, {
      status: 'processing',
      metadata: { ...meta, segments, demo },
    });

    return res.json({
      job: toPublicJob({
        ...job,
        status: 'processing',
        metadata: { ...meta, segments, demo },
      }),
      progress: Math.max(8, progress),
      step: 2,
      segmentsDone: done,
      segmentCount: total,
      message: `Vykresluji místnost ${done + 1} / ${total}…`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function failAndRefund(job, userId, error) {
  await updateVideoJob(job.id, { status: 'failed', error });
  await refundCredits(userId, job.credits_deducted, {
    sourceRef: 'ai_reel_refund',
    idempotencyKey: `refund-fail-${job.id}`,
    metadata: { reason: error },
  });
  await updateVideoJob(job.id, { status: 'refunded', error });
}

export default router;
