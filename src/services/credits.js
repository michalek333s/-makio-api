/**
 * Makio credit wallet — wallets + apply_ledger_entry (migration 0006).
 * RAM peněženka jen v lokálním demu. V production nikdy — jinak by šlo točit video zadarmo.
 */

const REQUIRED_VIDEO_CREDITS = Number(process.env.STAGING_VIDEO_CREDITS || 2);
const WELCOME_CREDITS = Number(process.env.STAGING_VIDEO_WELCOME_CREDITS || 5);
const STAGING_CREDITS_PER_IMAGE = Number(process.env.REEL_STAGING_CREDITS || 1);
const TTS_CREDITS = Number(process.env.REEL_TTS_CREDITS || 1);
const COMPOSE_CREDITS = Number(process.env.REEL_COMPOSE_CREDITS || 1);

/** @type {Map<string, number>} */
const memoryBalances = new Map();
/** @type {Set<string>} */
const memoryWelcomeGranted = new Set();

function supabaseCfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

function headers(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

/** @param {number} [imageCount=1] počet fotek / segmentů tour */
export function getRequiredVideoCredits(imageCount = 1) {
  const n = Math.max(1, Math.min(Number(imageCount) || 1, 12));
  return REQUIRED_VIDEO_CREDITS * n;
}

export function getCreditPriceLabel(imageCount = 1) {
  const czk = Number(process.env.STAGING_VIDEO_PRICE_CZK || 50);
  const n = Math.max(1, Math.min(Number(imageCount) || 1, 12));
  const credits = getRequiredVideoCredits(n);
  if (n <= 1) return `${credits} Kredity / ${czk} Kč`;
  return `${credits} Kredity · ${n} místností (${REQUIRED_VIDEO_CREDITS} kr / fotka)`;
}

export function getCreditsPerClip() {
  return REQUIRED_VIDEO_CREDITS;
}

/** Kredity pro plný Studio pipeline (staging + video + tts + compose). */
export function getPipelineCreditsBreakdown({
  imageCount = 1,
  stagingEnabled = true,
  withVoice = true,
  withCompose = true,
} = {}) {
  const n = Math.max(1, Math.min(Number(imageCount) || 1, 12));
  const staging = stagingEnabled ? STAGING_CREDITS_PER_IMAGE * n : 0;
  const video = REQUIRED_VIDEO_CREDITS * n;
  const tts = withVoice ? TTS_CREDITS : 0;
  const compose = withCompose ? COMPOSE_CREDITS : 0;
  return {
    staging,
    video,
    tts,
    compose,
    total: staging + video + tts + compose,
    imageCount: n,
    stagingPerImage: STAGING_CREDITS_PER_IMAGE,
    videoPerClip: REQUIRED_VIDEO_CREDITS,
  };
}

export function getRequiredPipelineCredits(opts) {
  return getPipelineCreditsBreakdown(opts).total;
}

/** Úsporný režim: 1× AI drone + Ken Burns + compose (+ volitelně TTS). */
export function getEconomyPipelineCreditsBreakdown({ withVoice = false } = {}) {
  const drone = Number(process.env.REEL_ECONOMY_DRONE_CREDITS || 2);
  const tts = withVoice ? TTS_CREDITS : 0;
  const compose = COMPOSE_CREDITS;
  return {
    staging: 0,
    video: drone,
    tts,
    compose,
    total: drone + tts + compose,
    imageCount: 1,
    stagingPerImage: 0,
    videoPerClip: drone,
    mode: 'economy',
    label: withVoice ? `${drone + tts + compose} kr (drone + voice + compose)` : `${drone + compose} kr (drone + compose)`,
  };
}

async function rpc(cfg, fn, args) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(cfg.serviceKey),
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === 'object' ? data?.message || data?.error : text;
    throw new Error(msg || `RPC ${fn} failed (${res.status})`);
  }
  return data;
}

/** Produkce a CREDITS_FAIL_CLOSED=1: žádný tichý RAM ledger. */
export function allowMemoryCredits() {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.CREDITS_FAIL_CLOSED !== '1';
}

function creditsUnavailable(cause, detail = '') {
  const hint = detail ? ` ${detail}` : '';
  const err = Object.assign(
    new Error(`Peněženka kreditů teď není dostupná.${hint} Video a reels nespouštějte — odečet by nebyl v databázi.`),
    { status: 503, code: 'CREDITS_UNAVAILABLE' },
  );
  if (cause) err.cause = cause;
  return err;
}

function ensureMemoryWallet(userId) {
  if (!memoryBalances.has(userId)) {
    memoryBalances.set(userId, 0);
  }
  if (!memoryWelcomeGranted.has(userId)) {
    memoryBalances.set(userId, (memoryBalances.get(userId) || 0) + WELCOME_CREDITS);
    memoryWelcomeGranted.add(userId);
  }
  // Local testing: keep wallet topped up when Supabase RPC migrations aren't applied
  const topup = Number(process.env.DEV_CREDITS_TOPUP || 0);
  if (
    topup > 0 &&
    process.env.NODE_ENV !== 'production' &&
    (memoryBalances.get(userId) || 0) < topup
  ) {
    memoryBalances.set(userId, topup);
  }
  return memoryBalances.get(userId) || 0;
}

/** Jen unit testy — nesmí volat produkční kód. */
export function resetMemoryCreditsForTests() {
  memoryBalances.clear();
  memoryWelcomeGranted.clear();
}

export async function getCreditsBalance(userId) {
  if (!userId) return { balance: 0, source: 'anonymous', requiredForVideo: REQUIRED_VIDEO_CREDITS };

  const cfg = supabaseCfg();
  if (!cfg) {
    if (!allowMemoryCredits()) throw creditsUnavailable(null, 'Chybí SUPABASE_URL / SERVICE_ROLE_KEY.');
    const balance = ensureMemoryWallet(userId);
    return {
      balance,
      source: 'memory',
      requiredForVideo: REQUIRED_VIDEO_CREDITS,
      creditsPerClip: REQUIRED_VIDEO_CREDITS,
    };
  }

  try {
    const balance = await rpc(cfg, 'ensure_wallet_with_welcome_credits', {
      p_user_id: userId,
      p_welcome: WELCOME_CREDITS,
    });
    return {
      balance: Number(balance) || 0,
      source: 'supabase',
      requiredForVideo: REQUIRED_VIDEO_CREDITS,
      creditsPerClip: REQUIRED_VIDEO_CREDITS,
    };
  } catch (err) {
    if (!allowMemoryCredits()) {
      console.error('[credits] supabase balance fail-closed:', err.message);
      throw creditsUnavailable(err, 'Supabase RPC selhalo.');
    }
    console.warn('[credits] supabase fallback → memory (dev):', err.message);
    const balance = ensureMemoryWallet(userId);
    return {
      balance,
      source: 'memory',
      requiredForVideo: REQUIRED_VIDEO_CREDITS,
      creditsPerClip: REQUIRED_VIDEO_CREDITS,
    };
  }
}

/**
 * Deduct credits (negative ledger). Returns new balance.
 * @throws if insufficient
 */
export async function deductCredits(userId, amount, { sourceRef, idempotencyKey, metadata } = {}) {
  if (!userId) throw Object.assign(new Error('Přihlášení vyžadováno.'), { status: 401 });
  const n = Math.abs(Number(amount) || 0);
  if (!n) throw new Error('Neplatná částka kreditů.');

  const cfg = supabaseCfg();
  if (!cfg) {
    if (!allowMemoryCredits()) throw creditsUnavailable(null, 'Chybí Supabase.');
    const bal = ensureMemoryWallet(userId);
    if (bal < n) {
      throw Object.assign(new Error('Nedostatek kreditů'), { status: 402, code: 'INSUFFICIENT_CREDITS' });
    }
    memoryBalances.set(userId, bal - n);
    return { balance: memoryBalances.get(userId), source: 'memory' };
  }

  const before = await getCreditsBalance(userId);
  if (before.source !== 'supabase' && !allowMemoryCredits()) {
    throw creditsUnavailable(null, 'Ledger není v Supabase.');
  }
  if (before.balance < n) {
    throw Object.assign(new Error('Nedostatek kreditů'), { status: 402, code: 'INSUFFICIENT_CREDITS' });
  }
  if (before.source === 'memory') {
    memoryBalances.set(userId, before.balance - n);
    return { balance: memoryBalances.get(userId), source: 'memory' };
  }

  try {
    await rpc(cfg, 'apply_ledger_entry', {
      p_user_id: userId,
      p_amount: -n,
      p_type: 'SPEND',
      p_source_ref: sourceRef || 'staging_video',
      p_metadata: metadata || {},
      p_idempotency_key: idempotencyKey || `spend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const after = await getCreditsBalance(userId);
    return { balance: after.balance, source: 'supabase' };
  } catch (err) {
    if (err.status === 503 || err.code === 'CREDITS_UNAVAILABLE') throw err;
    const missing = /Could not find|404/i.test(String(err.message || ''));
    if (missing && allowMemoryCredits()) {
      const bal = ensureMemoryWallet(userId);
      if (bal < n) {
        throw Object.assign(new Error('Nedostatek kreditů'), { status: 402, code: 'INSUFFICIENT_CREDITS' });
      }
      memoryBalances.set(userId, bal - n);
      return { balance: memoryBalances.get(userId), source: 'memory' };
    }
    if (!allowMemoryCredits()) throw creditsUnavailable(err, 'Odečet v ledgeru selhal.');
    throw err;
  }
}

export async function refundCredits(userId, amount, { sourceRef, idempotencyKey, metadata } = {}) {
  if (!userId || !amount) return { balance: null };
  const n = Math.abs(Number(amount) || 0);
  const cfg = supabaseCfg();
  if (!cfg) {
    if (!allowMemoryCredits()) throw creditsUnavailable(null, 'Refund nelze zapsat — chybí Supabase.');
    ensureMemoryWallet(userId);
    memoryBalances.set(userId, (memoryBalances.get(userId) || 0) + n);
    return { balance: memoryBalances.get(userId), source: 'memory' };
  }
  try {
    await rpc(cfg, 'apply_ledger_entry', {
      p_user_id: userId,
      p_amount: n,
      p_type: 'ADJUSTMENT',
      p_source_ref: sourceRef || 'staging_video_refund',
      p_metadata: metadata || { reason: 'provider_failed' },
      p_idempotency_key: idempotencyKey || `refund-${Date.now()}`,
    });
    const after = await getCreditsBalance(userId);
    return { balance: after.balance, source: 'supabase' };
  } catch (err) {
    if (!allowMemoryCredits()) {
      console.error('[credits] refund fail-closed:', err.message);
      throw creditsUnavailable(err, 'Refund se nezapsal do ledgeru.');
    }
    console.warn('[credits] refund fallback memory (dev):', err.message);
    ensureMemoryWallet(userId);
    memoryBalances.set(userId, (memoryBalances.get(userId) || 0) + n);
    return { balance: memoryBalances.get(userId), source: 'memory' };
  }
}

/**
 * Dobití kreditů (manuální platba / admin). Typ REWARD v ledgeru.
 * @throws 400 při neplatné částce; 503 bez ledgeru
 */
export async function grantCredits(userId, amount, { sourceRef, idempotencyKey, metadata } = {}) {
  if (!userId) throw Object.assign(new Error('Přihlášení vyžadováno.'), { status: 401 });
  const n = Math.floor(Math.abs(Number(amount) || 0));
  if (!n || n > 10_000) {
    throw Object.assign(new Error('Částka kreditů musí být 1–10000.'), { status: 400 });
  }

  const cfg = supabaseCfg();
  if (!cfg) {
    if (!allowMemoryCredits()) throw creditsUnavailable(null, 'Chybí Supabase.');
    ensureMemoryWallet(userId);
    memoryBalances.set(userId, (memoryBalances.get(userId) || 0) + n);
    return { balance: memoryBalances.get(userId), source: 'memory', granted: n };
  }

  try {
    await rpc(cfg, 'apply_ledger_entry', {
      p_user_id: userId,
      p_amount: n,
      p_type: 'REWARD',
      p_source_ref: sourceRef || 'manual_topup',
      p_metadata: metadata || {},
      p_idempotency_key:
        idempotencyKey || `topup-${userId}-${n}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const after = await getCreditsBalance(userId);
    return { balance: after.balance, source: 'supabase', granted: n };
  } catch (err) {
    if (!allowMemoryCredits()) throw creditsUnavailable(err, 'Dobití se nezapsalo do ledgeru.');
    console.warn('[credits] grant fallback memory (dev):', err.message);
    ensureMemoryWallet(userId);
    memoryBalances.set(userId, (memoryBalances.get(userId) || 0) + n);
    return { balance: memoryBalances.get(userId), source: 'memory', granted: n };
  }
}

/** Cena za 1 kredit (orientační marketing / UI). */
export function getCreditUnitPriceCzk() {
  return Number(process.env.STAGING_VIDEO_PRICE_CZK || 50) / Math.max(1, REQUIRED_VIDEO_CREDITS);
}
