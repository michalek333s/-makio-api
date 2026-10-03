/**
 * AI Video Promotion Engine
 * POST /api/staging/generate-video
 * GET  /api/staging/generate-video/:jobId
 * GET  /api/staging/credits
 */

import { Router } from 'express';
import {
  getCreditsBalance,
  deductCredits,
  refundCredits,
  getRequiredVideoCredits,
  getCreditPriceLabel,
} from '../services/credits.js';
import {
  CAMERA_PRESETS,
  getCameraPreset,
} from '../services/higgsfieldVideo.js';
import { startI2V, pollI2V, getProviderInfo } from '../services/videoProviders/index.js';
import {
  createVideoJob,
  updateVideoJob,
  getVideoJob,
  toPublicJob,
} from '../services/stagingVideoJobs.js';

const router = Router();

function requireUser(req, res) {
  if (!req.user?.id) {
    res.status(401).json({
      error: 'Přihlášení vyžadováno pro AI Video.',
      code: 'AUTH_REQUIRED',
    });
    return null;
  }
  return req.user;
}

router.get('/credits', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const bal = await getCreditsBalance(user.id);
    res.json({
      ...bal,
      priceLabel: getCreditPriceLabel(),
      presets: Object.values(CAMERA_PRESETS).map((p) => ({
        id: p.id,
        label: p.label,
        emoji: p.emoji,
      })),
      providerReady: getProviderInfo().provider !== 'mock',
    });
  } catch (err) {
    const status = Number(err.status) >= 400 && Number(err.status) < 600 ? err.status : 500;
    res.status(status).json({ error: err.message || 'Nelze načíst kredity.', code: err.code || undefined });
  }
});

router.post('/generate-video', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const sourceImageUrl = String(req.body?.sourceImageUrl || req.body?.imageUrl || '').trim();
  const cameraPreset = String(req.body?.cameraPreset || '').trim();
  const brokerageId = req.body?.brokerageId || null;

  if (!getCameraPreset(cameraPreset)) {
    return res.status(400).json({
      error: 'Vyberte platný camera preset.',
      presets: Object.keys(CAMERA_PRESETS),
    });
  }
  if (!sourceImageUrl) {
    return res.status(400).json({ error: 'Chybí sourceImageUrl (veřejná URL staged fotky).' });
  }

  const cost = getRequiredVideoCredits();
  const idempotencyKey = `video-${user.id}-${Date.now()}-${cameraPreset}`;

  let deducted = false;
  try {
    const afterDeduct = await deductCredits(user.id, cost, {
      sourceRef: 'staging_video',
      idempotencyKey,
      metadata: { cameraPreset, sourceImageUrl: sourceImageUrl.slice(0, 200) },
    });
    deducted = true;

    let provider;
    try {
      provider = await startI2V({
        imageUrl: sourceImageUrl,
        cameraPresetId: cameraPreset,
      });
    } catch (providerErr) {
      await refundCredits(user.id, cost, {
        sourceRef: 'staging_video_refund',
        idempotencyKey: `refund-${idempotencyKey}`,
        metadata: { reason: providerErr.message },
      });
      deducted = false;
      throw providerErr;
    }

    const job = await createVideoJob({
      userId: user.id,
      brokerageId,
      sourceImageUrl,
      cameraPreset,
      status: provider.status === 'queued' ? 'queued' : 'processing',
      provider: provider.provider,
      providerJobId: provider.providerJobId,
      providerStatusUrl: provider.statusUrl,
      creditsDeducted: cost,
      metadata: { demo: Boolean(provider.demo), idempotencyKey },
    });

    res.status(202).json({
      job: toPublicJob(job),
      credits: afterDeduct.balance,
      priceLabel: getCreditPriceLabel(),
      message: provider.demo
        ? 'Demo režim (bez HF_CREDENTIALS) — simuluji generování.'
        : 'Video se generuje. Pollujte GET /api/staging/generate-video/:jobId',
    });
  } catch (err) {
    if (deducted) {
      try {
        await refundCredits(user.id, cost, {
          sourceRef: 'staging_video_refund',
          idempotencyKey: `refund-err-${idempotencyKey}`,
          metadata: { reason: err.message },
        });
      } catch (refundErr) {
        console.error('[stagingVideo] refund failed:', refundErr.message);
      }
    }
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || 'Generování videa selhalo.',
      code: err.code || undefined,
      requiredCredits: cost,
    });
  }
});

router.get('/generate-video/:jobId', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const jobId = String(req.params.jobId || '').trim();
  const job = await getVideoJob(jobId, user.id);
  if (!job) return res.status(404).json({ error: 'Job nenalezen.' });

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'refunded') {
    return res.json({ job: toPublicJob(job) });
  }

  try {
    const poll = await pollI2V(job.provider_job_id, job.provider_status_url, job.provider);

    if (poll.status === 'completed' && poll.videoUrl) {
      const updated = await updateVideoJob(job.id, {
        status: 'completed',
        video_url: poll.videoUrl,
        metadata: { ...(job.metadata || {}), demo: Boolean(poll.demo) },
      });
      return res.json({ job: toPublicJob(updated || { ...job, status: 'completed', video_url: poll.videoUrl }), progress: 100 });
    }

    if (poll.status === 'failed') {
      await updateVideoJob(job.id, { status: 'failed', error: poll.error || 'failed' });
      try {
        await refundCredits(user.id, job.credits_deducted, {
          sourceRef: 'staging_video_refund',
          idempotencyKey: `refund-fail-${job.id}`,
          metadata: { reason: poll.error },
        });
        await updateVideoJob(job.id, { status: 'refunded', error: poll.error || 'failed' });
      } catch (e) {
        console.warn('[stagingVideo] refund on fail:', e.message);
      }
      const bal = await getCreditsBalance(user.id);
      return res.status(422).json({
        job: toPublicJob({ ...job, status: 'refunded', error: poll.error }),
        error: poll.error || 'Generování selhalo, kredity vráceny.',
        credits: bal.balance,
      });
    }

    const nextStatus = poll.status === 'queued' ? 'queued' : 'processing';
    await updateVideoJob(job.id, { status: nextStatus });
    return res.json({
      job: toPublicJob({ ...job, status: nextStatus }),
      progress: poll.progress ?? (nextStatus === 'queued' ? 15 : 55),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Poll selhal.' });
  }
});

export default router;
