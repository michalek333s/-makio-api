/**
 * Sdílené volání Gemini JSON (klíč jen z process.env).
 * Používá GEMINI_MODEL jako routes/ai.js.
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

async function fetchGemini({ model, payload }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const rawBody = await res.text();
  return { res, rawBody, model };
}

function parseError(rawBody) {
  let detail = '';
  try {
    const j = JSON.parse(rawBody);
    detail = j.error?.message || j.error?.status || '';
  } catch {
    detail = String(rawBody || '').slice(0, 280);
  }
  return detail;
}

/** Opraví běžně poškozený JSON z Gemini (oříznuté stringy, trailing commas). */
export function parseGeminiJsonText(text) {
  const cleaned = String(text || '')
    .replace(/^```json?\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* continue */
  }
  // Extrahuj největší {...} blok
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    let slice = cleaned.slice(start, end + 1);
    slice = slice.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(slice);
    } catch {
      /* continue */
    }
  }
  throw new Error('Gemini vrátila nevalidní JSON.');
}

/**
 * @param {{ systemInstruction?: string, userMessage: string, responseSchema?: object, generationConfigPatch?: object }} opts
 * @returns {Promise<object>} Parsovaný JSON z odpovědi
 */
export async function callGeminiJsonResponse({
  systemInstruction = '',
  userMessage,
  responseSchema,
  generationConfigPatch = {},
}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY není na serveru nastaven (nemio-backend/.env).');
  }

  const payload = {
    ...(systemInstruction?.trim()
      ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
      : {}),
    contents: [{ parts: [{ text: userMessage }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: 8192,
      ...(responseSchema ? { responseSchema } : {}),
      ...generationConfigPatch,
    },
  };

  const modelsToTry = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  const maxAttempts = Number.parseInt(process.env.GEMINI_RETRY_ATTEMPTS || '3', 10);
  let lastFailure = null;

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
      const { res, rawBody } = await fetchGemini({ model, payload });
      if (res.ok) {
        const data = JSON.parse(rawBody);
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text?.trim()) {
          throw new Error('Gemini vrátila prázdnou odpověď.');
        }
        return parseGeminiJsonText(text);
      }

      const detail = parseError(rawBody);
      lastFailure = { status: res.status, detail, model };

      // 400/403 jsou konfigurační chyby, retry nepomůže.
      if (res.status === 400 || res.status === 403) {
        throw new Error(`Gemini ${res.status}: ${detail || 'Neplatný klíč nebo zakázaný model.'}`);
      }

      // 404 = model neexistuje / není dostupný pro účet -> zkus fallback model.
      if (res.status === 404) break;

      // 429/5xx: zkus znovu s exponenciálním backoffem.
      if (RETRYABLE_STATUS.has(res.status) && attempt < Math.max(1, maxAttempts)) {
        const backoffMs = Math.min(1500 * 2 ** (attempt - 1), 8000);
        await sleep(backoffMs);
        continue;
      }
      break;
    }
  }

  if (lastFailure?.status === 429) {
    throw new Error(
      'Gemini: překročen limit nebo dočasné přetížení (429). Zkuste to za minutu; případně zkontrolujte kvótu na aistudio.google.com.',
    );
  }
  if (lastFailure?.status === 404) {
    throw new Error(
      lastFailure.detail ||
        `Model „${GEMINI_MODEL}“ není k dispozici. Nastavte GEMINI_MODEL / GEMINI_FALLBACK_MODELS podle https://ai.google.dev/models.`,
    );
  }
  if (lastFailure) {
    throw new Error(`Gemini ${lastFailure.status}${lastFailure.detail ? ': ' + lastFailure.detail : ''}`);
  }
  throw new Error('Gemini: neznámá chyba bez odpovědi.');
}
