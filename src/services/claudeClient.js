/**
 * Anthropic Claude — Messages API (klíč jen v process.env).
 * Použití: strukturovaný JSON výstup pro chat (stejný kontrakt jako Gemini v ai.js).
 */

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAnthropicError(rawBody) {
  try {
    const j = JSON.parse(rawBody);
    return j.error?.message || j.error?.type || '';
  } catch {
    return String(rawBody || '').slice(0, 280);
  }
}

/**
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {boolean} jsonOnly — přidat instrukci k čistému JSON (bez markdownu)
 * @returns {Promise<string>} Raw text odpovědi (JSON string nebo prostý text)
 */
export async function callClaudeMessages(systemPrompt, userMessage, jsonOnly = true) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY není na serveru nastaven (nemio-backend/.env).');
  }

  const userContent = jsonOnly
    ? `${userMessage}\n\nOdpověz POUZE jedním validním JSON objektem. Žádný markdown, žádné \`\`\`, žádný text před nebo za JSON.`
    : userMessage;

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  };

  const maxAttempts = Number.parseInt(process.env.CLAUDE_RETRY_ATTEMPTS || '3', 10);
  let lastFailure = null;

  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const rawBody = await res.text();

    if (res.ok) {
      const data = JSON.parse(rawBody);
      const block = data.content?.find((c) => c.type === 'text');
      const text = block?.text;
      if (!text?.trim()) {
        throw new Error('Claude vrátila prázdnou odpověď.');
      }
      return text;
    }

    const detail = parseAnthropicError(rawBody);
    lastFailure = { status: res.status, detail };

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(`Claude ${res.status}: ${detail || 'Neplatný klíč nebo zakázaný model.'}`);
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < Math.max(1, maxAttempts)) {
      const backoffMs = Math.min(1500 * 2 ** (attempt - 1), 8000);
      await sleep(backoffMs);
      continue;
    }

    break;
  }

  if (lastFailure?.status === 429) {
    throw new Error(
      'Claude: překročen limit (429) nebo dočasné přetížení. Zkuste za chvíli znovu nebo zkontrolujte plán na console.anthropic.com.',
    );
  }
  if (lastFailure) {
    throw new Error(`Claude ${lastFailure.status}${lastFailure.detail ? `: ${lastFailure.detail}` : ''}`);
  }
  throw new Error('Claude: neznámá chyba bez odpovědi.');
}
