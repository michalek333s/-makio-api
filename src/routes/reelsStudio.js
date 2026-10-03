/**
 * Reel Studio — script generation + format-aware video pipeline.
 * POST /api/reels/studio/script
 * POST /api/reels/studio/pipeline
 * GET  /api/reels/studio/jobs/:id
 * POST /api/reels/studio-generate (legacy multi-clip)
 */

import { Router } from 'express';
import multer from 'multer';
import { callClaudeMessages } from '../services/claudeClient.js';
import { generateDirectorPrompt } from '../services/reelDirector.js';
import { uploadReelSourceImage, MAX_REEL_IMAGES } from '../services/reelImageUpload.js';
import {
  getCameraPreset,
  isHiggsfieldConfigured,
  isHiggsfieldMockForced,
} from '../services/higgsfieldVideo.js';
import {
  startI2V,
  getProviderInfo,
  isFalConfigured,
} from '../services/videoProviders/index.js';
import { isDecor8Configured } from '../services/decor8Staging.js';
import { isTtsConfigured } from '../services/reelTts.js';
import { isFfmpegAvailable } from '../services/reelCompose.js';
import {
  startReelPipeline,
  getPipelineJobStatus,
} from '../services/reelPipeline.js';
import { startEconomyReelPipeline } from '../services/economyReelPipeline.js';
import {
  createVideoJob,
  toPublicJob,
} from '../services/stagingVideoJobs.js';
import {
  deductCredits,
  refundCredits,
  getRequiredVideoCredits,
  getCreditPriceLabel,
  getPipelineCreditsBreakdown,
  getEconomyPipelineCreditsBreakdown,
} from '../services/credits.js';
import {
  getStudioFormat,
  motionForClip,
  REEL_FORMAT_IDS,
} from '../config/reelFormats.js';

const router = Router();
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

function requireUser(req, res) {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Přihlášení vyžadováno.', code: 'AUTH_REQUIRED' });
    return null;
  }
  return req.user;
}

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.fields([
      { name: 'images', maxCount: MAX_FILES },
      { name: 'image', maxCount: 1 },
    ])(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

function runUploadSingle(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('image')(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

function collectFiles(req) {
  const multi = Array.isArray(req.files?.images) ? req.files.images : [];
  const single = Array.isArray(req.files?.image) ? req.files.image : [];
  const one = req.file ? [req.file] : [];
  return [...multi, ...single, ...one].slice(0, MAX_FILES);
}

function isJsonRequest(req) {
  return /application\/json/i.test(String(req.headers['content-type'] || ''));
}

function parseUrls(body) {
  const raw = body?.imageUrls || body?.imageUrl || '';
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

function parseListingDetails(body) {
  let raw = body?.listingDetails;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    title: String(d.title || '').trim(),
    price: String(d.price || '').trim(),
    location: String(d.location || '').trim(),
    disposition: String(d.disposition || '').trim(),
  };
}

function buildScriptSystemPrompt() {
  return `You are Makio, an elite Czech real-estate listing narrator and Reel scriptwriter.
Write spoken voiceover scripts for Instagram Reels / TikTok about property listings.
Rules:
- Czech language, warm professional broker tone (20y experience vibe).
- Never say you are an AI.
- Short spoken sentences suitable for voiceover.
- Include approximate timestamps for subtitle burn-in.
- Return ONLY valid JSON.`;
}

function buildScriptUserPayload({ formatId, listingDetails, photoCount, subtitleStyle }) {
  return {
    formatId,
    photoCount,
    subtitleStyle: subtitleStyle || 'hormozi',
    listing: listingDetails,
    outputSchema: {
      voiceoverScript: 'full spoken Czech script',
      subtitleCues: [{ startSec: 0, endSec: 3, text: '...' }],
      hookLine: 'first 2s hook',
      ctaLine: 'closing CTA',
    },
  };
}

function fallbackScript(listing, formatId) {
  const title = String(listing.title || '').trim();
  const price = String(listing.price || '').trim();
  const loc = String(listing.location || '').trim();
  const disp = String(listing.disposition || '').trim();
  const where = [disp, loc].filter(Boolean).join(' v lokalitě ');
  const name = title || (disp ? `Byt ${disp}` : 'Tato nemovitost');

  let voiceoverScript;
  if (formatId === 'voiceover_presentation') {
    voiceoverScript = [
      `Pojďte se podívat na ${name}${where ? `, ${where}` : ''}.`,
      'Prostor má jasný layout, dostatek světla a atmosféru, ve které se dobře žije.',
      price ? `Aktuální nabídková cena je ${price}.` : 'Detaily k ceně a termínu prohlídky vám rád pošlu.',
      'Napište mi a domluvíme si osobní prohlídku.',
    ].join(' ');
  } else {
    // standard_tour — krátký, lidský, bez „staging“ buzzwordu
    voiceoverScript = [
      `Krátká prohlídka: ${name}${where ? ` · ${where}` : ''}.`,
      price ? `Cena ${price}.` : '',
      'Prohlédněte si místnosti v klidu — ozvěte se mi pro termín nebo více fotek.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  return {
    voiceoverScript,
    hookLine: title || name,
    ctaLine: 'Napište mi pro prohlídku',
    subtitleCues: [
      { startSec: 0, endSec: 3, text: title || name },
      { startSec: 3, endSec: 7, text: [disp, loc].filter(Boolean).join(' · ') || 'Prohlídka nemovitosti' },
      { startSec: 7, endSec: 12, text: price || 'Domluvte si prohlídku' },
    ],
    usedFallback: true,
  };
}

/** GET /api/reels/studio/status — co je napojené (veřejné, bez user dat) */
router.get('/studio/status', async (req, res) => {
  const provider = getProviderInfo();
  const ffmpeg = await isFfmpegAvailable();
  res.json({
    ok: true,
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    higgsfield: isHiggsfieldConfigured(),
    fal: isFalConfigured(),
    decor8: isDecor8Configured(),
    tts: isTtsConfigured(),
    ffmpeg,
    provider: provider.provider,
    providerLabel: provider.label,
    mockForced: provider.mockForced,
    mockVideoAllowed:
      provider.provider === 'mock' ||
      isHiggsfieldConfigured() ||
      isFalConfigured() ||
      process.env.NODE_ENV !== 'production' ||
      process.env.STAGING_VIDEO_ALLOW_MOCK === '1',
    maxImages: MAX_FILES,
    formats: REEL_FORMAT_IDS,
    pipelineCreditsExample: getPipelineCreditsBreakdown({
      imageCount: 4,
      stagingEnabled: false,
      withVoice: true,
      withCompose: true,
    }),
    economyCreditsExample: getEconomyPipelineCreditsBreakdown({ withVoice: false }),
  });
});

/** POST /api/reels/studio/upload — jedna fotka → public URL */
router.post('/studio/upload', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    await runUploadSingle(req, res);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Neplatný upload.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Chybí soubor image.' });
  }
  try {
    const uploaded = await uploadReelSourceImage(req.file, user.id);
    res.json({
      publicUrl: uploaded.publicUrl,
      path: uploaded.path,
      bucket: uploaded.bucket,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Upload selhal.' });
  }
});

/** POST /api/reels/studio/script */
router.post('/studio/script', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const formatId = String(req.body?.formatId || '').trim();
  const format = getStudioFormat(formatId);
  if (!format) {
    return res.status(400).json({ error: 'Neplatný formát.', formats: REEL_FORMAT_IDS });
  }
  if (!format.supportsVoiceoverScript) {
    return res.status(400).json({
      error: 'Tento formát nepodporuje AI scénář voiceoveru.',
      formatId,
    });
  }

  const listingDetails = parseListingDetails(req.body);
  const photoCount = Number(req.body?.photoCount) || format.photoCount.min;
  const subtitleStyle = String(req.body?.subtitleStyle || 'hormozi').trim();

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.json({
      ...fallbackScript(listingDetails, formatId),
      formatId,
      model: 'fallback',
    });
  }

  try {
    const raw = await callClaudeMessages(
      buildScriptSystemPrompt(),
      JSON.stringify(buildScriptUserPayload({ formatId, listingDetails, photoCount, subtitleStyle })),
      true,
    );
    const cleaned = String(raw)
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    res.json({
      voiceoverScript: String(parsed.voiceoverScript || '').trim() || fallbackScript(listingDetails, formatId).voiceoverScript,
      hookLine: String(parsed.hookLine || '').trim(),
      ctaLine: String(parsed.ctaLine || '').trim(),
      subtitleCues: Array.isArray(parsed.subtitleCues) ? parsed.subtitleCues : [],
      formatId,
      model: process.env.CLAUDE_MODEL || 'claude',
      usedFallback: false,
    });
  } catch (err) {
    console.warn('[reels/studio/script]', err.message);
    res.json({
      ...fallbackScript(listingDetails, formatId),
      formatId,
      model: 'fallback',
      rejectReason: err.message,
    });
  }
});

/**
 * Before/after director prompt — static→motion crossfade language without forbidden words.
 */
function beforeAfterPrompt(phase, listing) {
  const loc = listing.location ? ` in ${listing.location}` : '';
  if (phase === 'before') {
    return `A 9:16 vertical cinematic real estate video. Slow locked-off hold then gentle dolly push-in on the unfinished room${loc}. Walls and furniture remain 100% rigid and static. Shot on 35mm lens, 8k photorealistic, smooth 60fps.`;
  }
  return `A 9:16 vertical cinematic real estate video. Smooth orbit reveal of the staged finished room${loc}. Walls and furniture remain 100% rigid and static. Shot on 35mm lens, 8k photorealistic, smooth 60fps.`;
}

/** POST /api/reels/studio-generate — multipart NEBO JSON { imageUrls } */
router.post('/studio-generate', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  if (!isJsonRequest(req)) {
    try {
      await runUpload(req, res);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Neplatný upload.' });
    }
  }

  const formatId = String(req.body?.formatId || '').trim();
  const format = getStudioFormat(formatId);
  if (!format) {
    return res.status(400).json({ error: 'Neplatný formát.', formats: REEL_FORMAT_IDS });
  }

  const subtitleStyle = String(req.body?.subtitleStyle || 'hormozi').trim();
  const voiceoverScript = String(req.body?.voiceoverScript || '').trim();
  const listingDetails = parseListingDetails(req.body);
  const files = isJsonRequest(req) ? [] : collectFiles(req);

  let imageUrls = [];
  if (files.length) {
    try {
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        const uploaded = await uploadReelSourceImage(file, user.id);
        imageUrls.push(uploaded.publicUrl);
      }
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Upload selhal.' });
    }
  } else {
    imageUrls = parseUrls(req.body).slice(0, MAX_FILES);
  }

  const n = imageUrls.length;
  if (n < format.photoCount.min || n > format.photoCount.max) {
    return res.status(400).json({
      error: `${format.title}: potřebujete ${format.photoCount.min}–${format.photoCount.max} fotek (máte ${n}).`,
      photoCount: format.photoCount,
    });
  }

  const cost = getRequiredVideoCredits(n);
  const idempotencyKey = `studio-${user.id}-${Date.now()}-${formatId}-${n}`;
  let deducted = false;

  try {
    const afterDeduct = await deductCredits(user.id, cost, {
      sourceRef: 'ai_reel_studio',
      idempotencyKey,
      metadata: { formatId, segmentCount: n, subtitleStyle },
    });
    deducted = true;

    const segments = [];
    let anyDemo = false;

    for (let i = 0; i < imageUrls.length; i += 1) {
      const imageUrl = imageUrls[i];
      let preset = motionForClip(format, i);
      let cameraPrompt;

      if (formatId === 'before_after_reveal') {
        cameraPrompt = beforeAfterPrompt(i === 0 ? 'before' : 'after', listingDetails);
        preset = i === 0 ? 'dolly_in' : 'orbit';
      } else {
        // eslint-disable-next-line no-await-in-loop
        const director = await generateDirectorPrompt({
          preset,
          roomType:
            formatId === 'quick_teaser'
              ? listingDetails.title || 'Living Room'
              : `Home tour room ${i + 1}`,
          style: listingDetails.disposition || '',
          imageUrl,
        });
        cameraPrompt = director.cameraPrompt;
      }

      if (!getCameraPreset(preset)) preset = 'dolly_in';

      let provider;
      try {
        // eslint-disable-next-line no-await-in-loop
        provider = await startI2V({
          imageUrl,
          cameraPresetId: preset,
          cameraPrompt,
        });
      } catch (providerErr) {
        await refundCredits(user.id, cost, {
          sourceRef: 'ai_reel_refund',
          idempotencyKey: `refund-${idempotencyKey}`,
          metadata: { reason: providerErr.message },
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
        cameraPrompt,
        preset,
        label:
          formatId === 'before_after_reveal' ? (i === 0 ? 'Před' : 'Po') : `Místnost ${i + 1}`,
      });
    }

    const job = await createVideoJob({
      userId: user.id,
      sourceImageUrl: imageUrls[0],
      cameraPreset: segments[0]?.preset || 'dolly_in',
      status: 'processing',
      provider: String(segments[0]?.providerJobId || '').startsWith('mock-') ? 'mock' : 'higgsfield',
      providerJobId: segments[0].providerJobId,
      providerStatusUrl: segments[0].statusUrl,
      creditsDeducted: cost,
      metadata: {
        demo: anyDemo,
        formatId,
        subtitleStyle,
        listingDetails,
        voiceoverScript: voiceoverScript || null,
        segmentCount: n,
        sourceImageUrls: imageUrls,
        segments,
        shotNotes: `${format.title} · ${n} klipů · ${subtitleStyle}`,
        product: 'ai_reel_studio',
        idempotencyKey,
      },
    });

    res.status(202).json({
      job: toPublicJob(job),
      formatId,
      credits: afterDeduct.balance,
      requiredCredits: cost,
      priceLabel: getCreditPriceLabel(n),
      providerReady: isHiggsfieldConfigured(),
      steps: [
        'Studio skládá formát a pohyby kamery…',
        n > 1 ? `Higgsfield renderuje ${n} klipů tour…` : 'Higgsfield renderuje reel…',
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
        console.error('[studio-generate] refund failed', e.message);
      }
    }
    res.status(err.status || 500).json({
      error: err.message || 'Studio generování selhalo.',
      code: err.code,
      requiredCredits: cost,
    });
  }
});

/** POST /api/reels/studio/pipeline — full I2V tour NEBO economy (drone + Ken Burns) */
router.post('/studio/pipeline', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const formatId = String(req.body?.formatId || '').trim();
  const imageUrls = parseUrls(req.body);
  // Property Reels = jen video z fotek (Decor8 staging je oddělený produkt)
  const stagingEnabled = false;
  const subtitleStyle = String(req.body?.subtitleStyle || 'hormozi').trim();
  const voiceoverScript = String(req.body?.voiceoverScript || '').trim();
  const voiceId = String(req.body?.voiceId || '').trim() || undefined;
  const designStyle = String(req.body?.designStyle || 'modern').trim();
  const listingDetails = parseListingDetails(req.body);
  const modeRaw = String(req.body?.mode || req.body?.pipelineMode || '').toLowerCase().trim();
  const economyMode =
    req.body?.economyMode === true ||
    req.body?.economyMode === 'true' ||
    modeRaw === 'economy' ||
    modeRaw === 'eco';
  let subtitleCues = req.body?.subtitleCues;
  if (typeof subtitleCues === 'string') {
    try {
      subtitleCues = JSON.parse(subtitleCues);
    } catch {
      subtitleCues = [];
    }
  }
  let roomTypes = req.body?.roomTypes;
  if (typeof roomTypes === 'string') {
    try {
      roomTypes = JSON.parse(roomTypes);
    } catch {
      roomTypes = [];
    }
  }

  try {
    const payload = {
      userId: user.id,
      formatId,
      imageUrls,
      stagingEnabled,
      designStyle,
      roomTypes: Array.isArray(roomTypes) ? roomTypes : [],
      subtitleStyle,
      voiceoverScript,
      subtitleCues: Array.isArray(subtitleCues) ? subtitleCues : [],
      listingDetails,
      voiceId,
    };

    const result = economyMode
      ? await startEconomyReelPipeline(payload)
      : await startReelPipeline(payload);

    res.status(202).json({
      ...result,
      formatId,
      mode: economyMode ? 'economy' : 'cinematic',
      priceLabel: economyMode
        ? `${result.requiredCredits} kr (úsporný režim)`
        : `${result.requiredCredits} kr (AI prohlídka)`,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || 'Pipeline selhala.',
      code: err.code,
      photoCount: err.photoCount,
    });
  }
});

/** GET /api/reels/studio/jobs/:id */
router.get('/studio/jobs/:id', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const data = await getPipelineJobStatus(String(req.params.id || ''), user.id);
    if (!data) return res.status(404).json({ error: 'Job nenalezen.' });
    if (data.job?.status === 'refunded' || data.job?.status === 'failed') {
      const { stringifyError } = await import('../lib/stringifyError.js');
      return res.status(422).json({
        error: stringifyError(data.job.error, 'Generování selhalo.'),
        ...data,
      });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
