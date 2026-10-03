/**
 * Text + JSON chat přes Gemini (sdílené pro router a routes/ai.js).
 */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash-lite,gemini-2.0-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((m) => m !== GEMINI_MODEL);

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parsuje JSON z Gemini; snese ``` fence a mírně useknutý konec.
 */
export function parseGeminiJsonText(raw) {
  if (!raw) throw new Error('Prázdná odpověď od AI.');
  let cleaned = String(raw).replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    cleaned = cleaned.slice(first, last + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    const repaired = repairTruncatedJson(cleaned);
    if (repaired) {
      try {
        return JSON.parse(repaired);
      } catch {
        /* fall through */
      }
    }
    throw Object.assign(new Error(`Neplatný JSON od AI: ${e1.message}`), {
      code: 'AI_JSON_PARSE',
      rawPreview: cleaned.slice(0, 400),
      rawLength: cleaned.length,
    });
  }
}

/** Uzavře useknuté stringy / závorky u truncated Gemini výstupu. */
function repairTruncatedJson(s) {
  let t = String(s || '').trim();
  if (!t.startsWith('{')) return null;

  let inString = false;
  let escape = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
  }
  if (inString) t += '"';

  const opens = { '{': 0, '[': 0 };
  inString = false;
  escape = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') opens['{'] += 1;
    else if (ch === '}') opens['{'] -= 1;
    else if (ch === '[') opens['['] += 1;
    else if (ch === ']') opens['['] -= 1;
  }
  t = t.replace(/,\s*$/, '');
  while (opens['['] > 0) {
    t += ']';
    opens['['] -= 1;
  }
  while (opens['{'] > 0) {
    t += '}';
    opens['{'] -= 1;
  }
  return t;
}

async function geminiGenerate(payload) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY není na serveru nastaven (nemio-backend/.env).');
  }

  const modelsToTry = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  const maxAttempts = Number.parseInt(process.env.GEMINI_RETRY_ATTEMPTS || '3', 10);
  let lastFailure = null;

  for (const model of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const rawBody = await res.text();
      if (res.ok) {
        const data = JSON.parse(rawBody);
        const parts = data.candidates?.[0]?.content?.parts || [];
        return parts.map((p) => p.text || '').join('') || undefined;
      }

      let detail = '';
      try {
        const j = JSON.parse(rawBody);
        detail = j.error?.message || j.error?.status || '';
      } catch {
        detail = rawBody.slice(0, 280);
      }
      lastFailure = { status: res.status, detail, model };

      if (res.status === 400 || res.status === 403) {
        throw new Error(`Gemini ${res.status}: ${detail || 'Neplatný klíč nebo zakázaný model.'}`);
      }
      if (res.status === 404) break;

      if (RETRYABLE_STATUS.has(res.status) && attempt < Math.max(1, maxAttempts)) {
        await sleep(Math.min(1500 * 2 ** (attempt - 1), 8000));
        continue;
      }
      break;
    }
  }

  if (lastFailure?.status === 429) {
    throw new Error('Gemini: limit 429 — počkejte a zkuste znovu.');
  }
  if (lastFailure) {
    throw new Error(`Gemini ${lastFailure.status}${lastFailure.detail ? `: ${lastFailure.detail}` : ''}`);
  }
  throw new Error('Gemini: neznámá chyba.');
}

/** Prostý text (SMS, polish, GeoPas wrap). */
export async function callGeminiText(systemPrompt, userMessage) {
  return geminiGenerate({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userMessage }] }],
    generationConfig: {
      maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 4096) || 4096,
    },
  });
}

/** JSON schema (CRM chat). */
export async function callGeminiJson(systemPrompt, userMessage, responseSchema) {
  const maxOut = Number(process.env.GEMINI_JSON_MAX_OUTPUT_TOKENS || 4096) || 4096;
  return geminiGenerate({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userMessage }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      temperature: 0.35,
      maxOutputTokens: maxOut,
    },
  });
}
