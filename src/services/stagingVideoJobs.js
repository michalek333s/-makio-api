/**
 * Persist staging video jobs (Supabase) with in-memory fallback.
 */

import { randomUUID } from 'crypto';

/** @type {Map<string, object>} */
const memoryJobs = new Map();

function cfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

function headers(serviceKey, prefer = 'return=representation') {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: prefer,
  };
}

export async function createVideoJob(row) {
  const id = row.id || randomUUID();
  const record = {
    id,
    user_id: row.userId,
    brokerage_id: row.brokerageId || null,
    source_image_url: row.sourceImageUrl,
    camera_preset: row.cameraPreset,
    status: row.status || 'queued',
    video_url: null,
    provider: row.provider || 'higgsfield',
    provider_job_id: row.providerJobId || null,
    provider_status_url: row.providerStatusUrl || null,
    credits_deducted: row.creditsDeducted || 2,
    error: null,
    metadata: row.metadata || {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const c = cfg();
  if (!c) {
    memoryJobs.set(id, record);
    return record;
  }

  try {
    const res = await fetch(`${c.supabaseUrl}/rest/v1/staging_video_jobs`, {
      method: 'POST',
      headers: headers(c.serviceKey),
      body: JSON.stringify(record),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.warn('[stagingVideoJobs] insert failed, memory fallback:', errText.slice(0, 200));
      memoryJobs.set(id, record);
      return record;
    }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.warn('[stagingVideoJobs] insert error, memory:', err.message);
    memoryJobs.set(id, record);
    return record;
  }
}

export async function updateVideoJob(id, patch) {
  const updates = {
    ...patch,
    updated_at: new Date().toISOString(),
  };

  if (memoryJobs.has(id)) {
    const next = { ...memoryJobs.get(id), ...updates };
    memoryJobs.set(id, next);
  }

  const c = cfg();
  if (!c) return memoryJobs.get(id) || null;

  try {
    const res = await fetch(
      `${c.supabaseUrl}/rest/v1/staging_video_jobs?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: headers(c.serviceKey),
        body: JSON.stringify(updates),
      },
    );
    if (!res.ok) {
      return memoryJobs.get(id) || null;
    }
    const data = await res.json();
    const row = Array.isArray(data) ? data[0] : data;
    return row || memoryJobs.get(id) || null;
  } catch {
    return memoryJobs.get(id) || null;
  }
}

export async function getVideoJob(id, userId) {
  if (memoryJobs.has(id)) {
    const job = memoryJobs.get(id);
    if (userId && job.user_id !== userId) return null;
    return job;
  }

  const c = cfg();
  if (!c) return null;

  let url =
    `${c.supabaseUrl}/rest/v1/staging_video_jobs?id=eq.${encodeURIComponent(id)}&select=*`;
  if (userId) url += `&user_id=eq.${encodeURIComponent(userId)}`;

  const res = await fetch(url, { headers: headers(c.serviceKey, '') });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? data[0] || null : data;
}

export function toPublicJob(job) {
  if (!job) return null;
  const segments = Array.isArray(job.metadata?.segments) ? job.metadata.segments : [];
  const playlistUrls = segments
    .filter((s) => s?.status === 'completed' && s.videoUrl)
    .map((s) => s.videoUrl);
  return {
    id: job.id,
    status: job.status,
    videoUrl: job.video_url || playlistUrls[0] || null,
    playlistUrls: playlistUrls.length ? playlistUrls : job.video_url ? [job.video_url] : [],
    segmentCount: Number(job.metadata?.segmentCount) || segments.length || 1,
    segmentsDone: playlistUrls.length,
    cameraPreset: job.camera_preset,
    creditsDeducted: job.credits_deducted,
    error: job.error || null,
    demo: Boolean(job.metadata?.demo),
    product: job.metadata?.product || 'ai_reel',
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}
