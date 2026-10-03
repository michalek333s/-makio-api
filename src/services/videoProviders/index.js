/**
 * Unified I2V provider router for Makio Reels.
 * REEL_VIDEO_PROVIDER=mock|wan|seedance|kling|higgsfield
 * HF_FORCE_MOCK=1 always forces mock.
 * Default: wan (cost-efficient cinematic room clips).
 */

import { randomUUID } from 'crypto';
import {
  startImageToVideo as startHiggsfield,
  pollImageToVideo as pollHiggsfield,
  isHiggsfieldConfigured,
  isHiggsfieldMockForced,
  getCameraPreset,
} from '../higgsfieldVideo.js';
import { startFalI2V, pollFalI2V, isFalConfigured } from './fal.js';
import {
  enforceFidelityPrompt,
  REEL_MOTION_TEMPLATES,
} from '../../prompts/reelDirectorMasterPrompt.js';

const MOCK_MP4 =
  process.env.STAGING_VIDEO_DEMO_MP4 ||
  'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4';

const FAL_MODELS = new Set(['wan', 'seedance', 'kling']);

/** @type {Map<string, { createdAt: number }>} */
const mockJobs = new Map();

export function getConfiguredProviderId() {
  if (isHiggsfieldMockForced() || String(process.env.REEL_VIDEO_PROVIDER || '').toLowerCase() === 'mock') {
    return 'mock';
  }
  const raw = String(process.env.REEL_VIDEO_PROVIDER || 'wan').toLowerCase().trim();
  if (FAL_MODELS.has(raw)) {
    if (isFalConfigured()) return raw;
    if (isHiggsfieldConfigured()) return 'higgsfield';
    return 'mock';
  }
  if (raw === 'higgsfield') {
    if (isHiggsfieldConfigured()) return 'higgsfield';
    if (isFalConfigured()) return 'wan';
    return 'mock';
  }
  if (isFalConfigured()) return 'wan';
  if (isHiggsfieldConfigured()) return 'higgsfield';
  return 'mock';
}

export function getProviderInfo() {
  const id = getConfiguredProviderId();
  return {
    provider: id,
    fal: isFalConfigured(),
    higgsfield: isHiggsfieldConfigured(),
    mockForced: isHiggsfieldMockForced() || id === 'mock',
    label:
      id === 'wan'
        ? 'Wan 2.2 720p (fal)'
        : id === 'seedance'
          ? 'Seedance (fal)'
          : id === 'kling'
            ? 'Kling (fal)'
            : id === 'higgsfield'
              ? 'Higgsfield'
              : 'Mock test',
  };
}

function startMock({ imageUrl, cameraPresetId }) {
  const id = `mock-${randomUUID()}`;
  mockJobs.set(id, { createdAt: Date.now(), imageUrl, cameraPresetId });
  return {
    provider: 'mock',
    providerJobId: id,
    statusUrl: null,
    status: 'queued',
    demo: true,
  };
}

function pollMock(providerJobId) {
  const job = mockJobs.get(providerJobId);
  if (!job && !String(providerJobId || '').startsWith('mock-')) {
    return { status: 'failed', error: 'Mock job not found' };
  }
  const createdAt = job?.createdAt || Date.now() - 5000;
  const age = Date.now() - createdAt;
  if (age < 3500) {
    return { status: 'processing', progress: Math.min(90, Math.round(age / 40)), demo: true };
  }
  return { status: 'completed', videoUrl: MOCK_MP4, demo: true, progress: 100 };
}

/**
 * @param {{ imageUrl: string, cameraPresetId?: string, cameraPrompt?: string, aspectRatio?: string }} params
 */
export async function startI2V(params) {
  const imageUrl = String(params.imageUrl || '').trim();
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw Object.assign(new Error('imageUrl musí být veřejná https URL.'), { status: 400 });
  }
  const provider = getConfiguredProviderId();
  const preset = params.cameraPresetId || 'dolly_in';
  const prompt = enforceFidelityPrompt(
    String(params.cameraPrompt || '').trim() ||
      getCameraPreset(preset)?.prompt ||
      REEL_MOTION_TEMPLATES[preset] ||
      REEL_MOTION_TEMPLATES.dolly_in,
    preset,
  );

  if (provider === 'mock') {
    return startMock({ imageUrl, cameraPresetId: preset });
  }

  if (FAL_MODELS.has(provider)) {
    return startFalI2V({
      model: provider,
      imageUrl,
      prompt,
      aspectRatio: params.aspectRatio || '9:16',
    });
  }

  return startHiggsfield({
    imageUrl,
    cameraPresetId: preset,
    cameraPrompt: prompt,
  });
}

export async function pollI2V(providerJobId, statusUrl, providerHint) {
  const id = String(providerJobId || '');
  if (id.startsWith('mock-') || providerHint === 'mock') {
    return pollMock(id);
  }
  if (
    id.startsWith('fal-') ||
    providerHint === 'wan' ||
    providerHint === 'seedance' ||
    providerHint === 'kling'
  ) {
    return pollFalI2V(id, statusUrl);
  }
  return pollHiggsfield(providerJobId, statusUrl);
}

export { getCameraPreset, isHiggsfieldMockForced, isHiggsfieldConfigured, isFalConfigured };
