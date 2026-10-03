/**
 * Centrální routování AI modelů — úspora kreditů (Claude jen kde má smysl).
 *
 * .env:
 *   CHAT_PROVIDER=gemini|claude|auto     — CRM chat, SMS, polish (auto = gemini preferuje)
 *   GEOPAS_CHAT_MODE=pipeline|claude|auto — nemovitosti v chatu
 *   CLAUDE_DAILY_BUDGET=20               — max Claude volání / kalendářní den (0 = bez limitu)
 *   CLAUDE_BUDGET_GEOPAS=5               — podlimit jen pro GeoPas agenta (volitelné)
 *   CLAUDE_BUDGET_CHAT=15                — podlimit pro chat/sms/polish (volitelné)
 */

export const AiTask = {
  CHAT_CRM: 'chat_crm',
  GEOPAS_CHAT: 'geopas_chat',
  GEOPAS_WRAP: 'geopas_wrap',
  SMS: 'sms',
  POLISH: 'polish',
  LISTING: 'listing',
  RADAR: 'radar',
};

export function aiCapabilities() {
  return {
    geopas: Boolean(process.env.GEOPAS_API_KEY?.trim()),
    gemini: Boolean(process.env.GEMINI_API_KEY?.trim()),
    claude: Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_API_KEY?.trim()),
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
  };
}

function normMode(raw, fallback) {
  const v = String(raw || fallback).trim().toLowerCase();
  return v;
}

/** CRM chat, SMS, polish */
export function resolveChatProviderMode() {
  return normMode(process.env.CHAT_PROVIDER, 'gemini');
}

/** GeoPas dotaz v AI chatu: pipeline (levné) vs claude agent (drahé) */
export function resolveGeopasChatMode() {
  return normMode(process.env.GEOPAS_CHAT_MODE, 'pipeline');
}

export function geopasPipelineUsesGeminiWrap({ fromCache = false } = {}) {
  if (process.env.GEOPAS_PIPELINE_GEMINI_WRAP === '0') return false;
  // Z cache: stejná data → přeskočit Gemini wrap = rychlejší a konzistentnější odpověď
  if (fromCache && process.env.GEOPAS_PIPELINE_SKIP_WRAP_ON_CACHE !== '0') return false;
  return true;
}

/**
 * @returns {'gemini'|'claude'}
 */
export function pickLlmForTask(task, { preferClaude = false } = {}) {
  const caps = aiCapabilities();
  const chatMode = resolveChatProviderMode();

  if (preferClaude || chatMode === 'claude') {
    if (caps.claude) return 'claude';
    if (caps.gemini) return 'gemini';
    throw new Error('CHAT_PROVIDER=claude ale chybí ANTHROPIC_API_KEY.');
  }

  if (chatMode === 'gemini') {
    if (caps.gemini) return 'gemini';
    if (caps.claude) return 'claude';
    throw new Error('CHAT_PROVIDER=gemini ale chybí GEMINI_API_KEY.');
  }

  // auto — šetříme: výchozí Gemini, Claude jen pokud Gemini chybí
  if (caps.gemini) return 'gemini';
  if (caps.claude) return 'claude';
  throw new Error('Není nastaven GEMINI_API_KEY ani ANTHROPIC_API_KEY.');
}

/**
 * @returns {{ kind: 'claude_agent'|'pipeline'|'none', reason?: string }}
 */
export function resolveGeopasChatStrategy({ budgetAllowsClaude = true } = {}) {
  const caps = aiCapabilities();
  if (!caps.geopas) {
    return { kind: 'none', reason: 'GEOPAS_API_KEY chybí' };
  }

  const mode = resolveGeopasChatMode();

  if (mode === 'pipeline') {
    return { kind: 'pipeline' };
  }

  if (mode === 'claude') {
    if (caps.claude && budgetAllowsClaude) {
      return { kind: 'claude_agent' };
    }
    return { kind: 'pipeline', fallback: true, reason: 'claude_unavailable' };
  }

  // auto: pipeline default; Claude jen pokud explicitně povoleno
  const autoClaude =
    process.env.GEOPAS_CHAT_AUTO_CLAUDE === '1' || process.env.GEOPAS_CHAT_AUTO_CLAUDE === 'true';
  if (autoClaude && caps.claude && budgetAllowsClaude) {
    return { kind: 'claude_agent' };
  }

  return { kind: 'pipeline' };
}

export function getRoutingSummary() {
  const caps = aiCapabilities();
  const geopasMode = resolveGeopasChatMode();
  const chatMode = resolveChatProviderMode();
  const budget = readBudgetConfig();

  return {
    chatProvider: chatMode,
    geopasChatMode: geopasMode,
    geopasPipelineGeminiWrap: geopasPipelineUsesGeminiWrap(),
    capabilities: caps,
    claudeBudget: budget,
  };
}

export function readBudgetConfig() {
  const total = Number.parseInt(process.env.CLAUDE_DAILY_BUDGET || '0', 10);
  const geopas = Number.parseInt(process.env.CLAUDE_BUDGET_GEOPAS || '0', 10);
  const chat = Number.parseInt(process.env.CLAUDE_BUDGET_CHAT || '0', 10);
  return {
    dailyTotal: Number.isFinite(total) ? total : 0,
    geopas: Number.isFinite(geopas) ? geopas : 0,
    chat: Number.isFinite(chat) ? chat : 0,
  };
}
