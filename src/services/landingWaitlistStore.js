/**
 * Lokální fallback waitlistu, když v Supabase chybí tabulka landing_waitlist.
 * Po spuštění migrace 0019/0043 se automaticky preferuje Supabase.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const STORE_PATH = path.join(DATA_DIR, 'landing-waitlist.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ entries: [] }, null, 2), 'utf8');
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    return { entries };
  } catch {
    return { entries: [] };
  }
}

function writeStore(entries) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify({ entries, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

export function isMissingWaitlistTableError(err) {
  const msg = String(err?.message || err || '');
  return /PGRST205|landing_waitlist|Could not find the table/i.test(msg);
}

export function fileWaitlistCount() {
  return readStore().entries.length;
}

export function fileWaitlistAdd({ email, painPoint, gdprConsent }) {
  const store = readStore();
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (store.entries.some((e) => e.email === normalized)) {
    const dup = new Error('duplicate');
    dup.code = 'DUPLICATE';
    throw dup;
  }
  store.entries.push({
    email: normalized,
    pain_point: painPoint || null,
    gdpr_consent: Boolean(gdprConsent),
    source: 'landing-file',
    created_at: new Date().toISOString(),
  });
  writeStore(store.entries);
  return store.entries.length;
}
