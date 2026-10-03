/**
 * Disková L3 cache GeoPas — přežije restart, když Supabase DNS/URL padá.
 * Cesta: nemio-backend/.cache/geopas/*.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '../../.cache/geopas');

function safeFileName(key) {
  return String(key || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 180);
}

export function diskCacheEnabled() {
  return process.env.GEOPAS_DISK_CACHE !== '0' && process.env.GEOPAS_DISK_CACHE !== 'false';
}

export async function ensureDiskCacheDir() {
  if (!diskCacheEnabled()) return;
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

export async function diskCacheGet(key) {
  if (!diskCacheEnabled() || !key) return null;
  const file = path.join(CACHE_DIR, `${safeFileName(key)}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const row = JSON.parse(raw);
    if (!row?.expiresAt || Date.now() > row.expiresAt) {
      await fs.unlink(file).catch(() => {});
      return null;
    }
    return {
      data: row.data,
      cachedAt: row.cachedAt,
      expiresAt: row.expiresAt,
      source: 'disk',
    };
  } catch {
    return null;
  }
}

export async function diskCacheSet(key, entry, meta = {}) {
  if (!diskCacheEnabled() || !key || !entry) return false;
  await ensureDiskCacheDir();
  const file = path.join(CACHE_DIR, `${safeFileName(key)}.json`);
  const body = {
    cache_key: key,
    query_text: meta.query || null,
    parcel_id: meta.parcelId ?? null,
    address: meta.address || null,
    data: entry.data,
    cachedAt: entry.cachedAt,
    expiresAt: entry.expiresAt,
    writtenAt: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(body), 'utf8');
  return true;
}

export async function diskCacheStats() {
  if (!diskCacheEnabled()) return { enabled: false, files: 0, dir: CACHE_DIR };
  try {
    await ensureDiskCacheDir();
    const files = await fs.readdir(CACHE_DIR);
    const json = files.filter((f) => f.endsWith('.json'));
    return { enabled: true, files: json.length, dir: CACHE_DIR };
  } catch {
    return { enabled: true, files: 0, dir: CACHE_DIR };
  }
}

export { CACHE_DIR };
