/**
 * L3 cache na disk — přežije restart backendu když Supabase selže.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../.cache');
const CACHE_FILE = join(CACHE_DIR, 'radar-listings.json');

function enabled() {
  return process.env.RADAR_DISK_CACHE !== '0';
}

function regionKey(region, propertyType) {
  return `${String(region).trim()}::${String(propertyType || 'byty').trim()}`;
}

function readStore() {
  if (!existsSync(CACHE_FILE)) return { regions: {} };
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return { regions: {} };
  }
}

function writeStore(store) {
  if (!enabled()) return;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(store, null, 0), 'utf8');
}

export function loadDiskListings(region, propertyType) {
  if (!enabled()) return [];
  const store = readStore();
  const rk = regionKey(region, propertyType);
  const row = store.regions?.[rk];
  if (!row?.listings?.length) return [];
  const expiresAt = Date.parse(row.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return [];
  return row.listings;
}

export function persistDiskListings(listings, { region, propertyType } = {}) {
  if (!enabled() || !Array.isArray(listings) || listings.length === 0) return;
  const ttlHours = Number(process.env.RADAR_CACHE_TTL_HOURS || 12);
  const ttlMs = (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 12) * 3600_000;
  const rk = regionKey(region, propertyType);
  const store = readStore();
  const existing = store.regions?.[rk]?.listings || [];
  const byKey = new Map();
  for (const l of existing) {
    byKey.set(`${l.source}:${l.listingId}`, l);
  }
  for (const l of listings) {
    byKey.set(`${l.source}:${l.listingId}`, l);
  }
  store.regions = store.regions || {};
  store.regions[rk] = {
    listings: [...byKey.values()],
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
}
