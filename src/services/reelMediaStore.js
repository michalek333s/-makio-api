/**
 * Upload final reel MP4 — Supabase Storage first, local /media/reels fallback
 * when bucket rejects video/mp4 (InvalidMimeType).
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REEL_MEDIA_DIR = path.resolve(__dirname, '../../data/reel-media');

function supabaseCfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

function publicBackendBase() {
  // Relativní URL → Vite proxy /media → backend (stejný origin ve FE)
  if (process.env.REEL_MEDIA_ABSOLUTE === '1') {
    const raw =
      process.env.BACKEND_PUBLIC_URL ||
      process.env.API_PUBLIC_URL ||
      `http://127.0.0.1:${process.env.PORT || 3001}`;
    return String(raw).replace(/\/$/, '');
  }
  return '';
}

function isMimeRejected(status, bodyText) {
  const t = String(bodyText || '');
  return (
    status === 400 ||
    status === 415 ||
    /InvalidMimeType|Unsupported Media Type|mime type video\/mp4/i.test(t)
  );
}

async function saveLocalMp4(buffer, userId) {
  await fs.mkdir(REEL_MEDIA_DIR, { recursive: true });
  const safeUser = String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon';
  const name = `${safeUser}-${randomUUID()}.mp4`;
  const dest = path.join(REEL_MEDIA_DIR, name);
  await fs.writeFile(dest, buffer);
  const base = publicBackendBase();
  const url = `${base}/media/reels/${name}`;
  console.warn('[reelMediaStore] Supabase MIME reject → local file', name);
  return url;
}

/**
 * @param {Buffer} buffer
 * @param {string} userId
 * @param {{ folder?: string }} [opts]
 * @returns {Promise<string>} public https URL
 */
export async function uploadReelMp4(buffer, userId, opts = {}) {
  if (!buffer?.length) {
    throw Object.assign(new Error('Prázdné MP4.'), { status: 400 });
  }

  const cfg = supabaseCfg();
  const bucket = String(process.env.REEL_UPLOAD_BUCKET || 'staging-uploads').trim();
  const folder = String(opts.folder || 'final').replace(/[^a-zA-Z0-9/_-]/g, '') || 'final';
  const safeUser = String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon';
  const objectPath = `reels/${safeUser}/${folder}/${randomUUID()}.mp4`;

  if (cfg) {
    try {
      const res = await fetch(`${cfg.supabaseUrl}/storage/v1/object/${bucket}/${objectPath}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.serviceKey}`,
          apikey: cfg.serviceKey,
          'Content-Type': 'video/mp4',
          'x-upsert': 'true',
        },
        body: buffer,
      });
      if (res.ok) {
        return `${cfg.supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
      }
      const t = await res.text().catch(() => '');
      if (isMimeRejected(res.status, t)) {
        return saveLocalMp4(buffer, userId);
      }
      throw Object.assign(
        new Error(`Upload MP4 selhal (${res.status}): ${t.slice(0, 180)}`),
        { status: 502 },
      );
    } catch (err) {
      if (err.status === 502) throw err;
      console.warn('[reelMediaStore] upload error → local', err.message);
      return saveLocalMp4(buffer, userId);
    }
  }

  return saveLocalMp4(buffer, userId);
}
