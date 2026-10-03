import { readBudgetConfig } from '../config/aiRouting.js';

/** Počítadlo Claude volání v paměti (reset o půlnoci UTC). Pro produkci později Redis/DB. */
const state = {
  dayKey: '',
  total: 0,
  geopas_chat: 0,
  chat_crm: 0,
  sms: 0,
  polish: 0,
  geopas_wrap: 0,
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetIfNewDay() {
  const k = todayKey();
  if (state.dayKey !== k) {
    state.dayKey = k;
    state.total = 0;
    state.geopas_chat = 0;
    state.chat_crm = 0;
    state.sms = 0;
    state.polish = 0;
    state.geopas_wrap = 0;
  }
}

function bucketKey(task) {
  if (task === 'geopas_chat') return 'geopas_chat';
  if (task === 'geopas_wrap') return 'geopas_wrap';
  if (task === 'sms') return 'sms';
  if (task === 'polish') return 'polish';
  return 'chat_crm';
}

export function getClaudeUsageSnapshot() {
  resetIfNewDay();
  const cfg = readBudgetConfig();
  return {
    date: state.dayKey,
    used: { ...state },
    limits: cfg,
  };
}

/**
 * @param {string} task — AiTask nebo alias
 */
export function canSpendClaude(task) {
  resetIfNewDay();
  const cfg = readBudgetConfig();
  const key = bucketKey(task);

  if (cfg.dailyTotal > 0 && state.total >= cfg.dailyTotal) {
    return { ok: false, reason: 'daily_total' };
  }
  if (key === 'geopas_chat' && cfg.geopas > 0 && state.geopas_chat >= cfg.geopas) {
    return { ok: false, reason: 'geopas_cap' };
  }
  if (
    (key === 'chat_crm' || key === 'sms' || key === 'polish') &&
    cfg.chat > 0 &&
    state[key] >= cfg.chat
  ) {
    return { ok: false, reason: 'chat_cap' };
  }

  return { ok: true };
}

export function recordClaudeSpend(task) {
  resetIfNewDay();
  const key = bucketKey(task);
  state.total += 1;
  if (state[key] !== undefined) state[key] += 1;
}
