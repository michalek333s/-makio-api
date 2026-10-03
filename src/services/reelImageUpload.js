/**
 * Upload source still for AI Reel → public HTTPS URL for Higgsfield.
 * Uses Supabase Storage bucket `staging-uploads` (migration 0008).
 */

import { randomUUID } from 'crypto';

const BUCKET = String(process.env.REEL_UPLOAD_BUCKET || 'staging-uploads').trim();
const MAX_BYTES = Number(process.env.REEL_UPLOAD_MAX_BYTES || 12 * 1024 * 1024);

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function supabaseCfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

/**
 * @param {{ buffer: Buffer, mimetype: string, originalname?: string }} file
 * @param {string} userId
 * @returns {Promise<{ publicUrl: string, path: string, bucket: string }>}
 */
export async function uploadReelSourceImage(file, userId) {
  if (!file?.buffer?.length) {
    throw Object.assign(new Error('Chybí soubor fotky.'), { status: 400 });
  }
  if (file.buffer.length > MAX_BYTES) {
    throw Object.assign(new Error(`Fotka je moc velká (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).`), {
      status: 400,
    });
  }

  const mime = String(file.mimetype || '').toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) {
    throw Object.assign(new Error('Povolené formáty: JPG, PNG, WebP, HEIC.'), { status: 400 });
  }

  const cfg = supabaseCfg();
  if (!cfg) {
    throw Object.assign(
      new Error('Upload fotek vyžaduje SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY na backendu.'),
      { status: 503 },
    );
  }

  const safeUser = String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon';
  const objectPath = `reels/${safeUser}/${randomUUID()}.${ext}`;

  const uploadUrl = `${cfg.supabaseUrl}/storage/v1/object/${BUCKET}/${objectPath}`;
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.serviceKey}`,
      apikey: cfg.serviceKey,
      'Content-Type': mime,
      'x-upsert': 'true',
    },
    body: file.buffer,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`Upload do storage selhal (${res.status}): ${text.slice(0, 200)}`),
      { status: 502 },
    );
  }

  const publicUrl = `${cfg.supabaseUrl}/storage/v1/object/public/${BUCKET}/${objectPath}`;
  return { publicUrl, path: objectPath, bucket: BUCKET };
}

/**
 * Upload více fotek pro home-tour reel.
 * @param {Array<{ buffer: Buffer, mimetype: string, originalname?: string }>} files
 * @param {string} userId
 */
export async function uploadReelSourceImages(files, userId) {
  const list = Array.isArray(files) ? files : [];
  const out = [];
  for (const file of list) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await uploadReelSourceImage(file, userId));
  }
  return out;
}

export const MAX_REEL_IMAGES = Number(process.env.REEL_MAX_IMAGES || 8);
