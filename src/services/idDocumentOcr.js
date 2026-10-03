/**
 * OCR občanského průkazu / pasu.
 * Fotka se NEUKLÁDÁ — jen jednorázově odejde do AI a výsledek je text.
 * Preferuje OpenAI GPT-4o Vision; při chybě / bez kreditů Gemini Flash.
 */

import { assertImagePayload } from '../lib/requestValidation.js';
import { parseGeminiJsonText } from './geminiChat.js';

const EXTRACT_PROMPT = `Jsi OCR asistent pro české doklady totožnosti (občanský průkaz, pas).
Z fotky vytáhni pouze údaje viditelné na dokladu. Nic nevymýšlej.

Vrať POUZE JSON (bez markdownu):
{
  "full_name": "jméno a příjmení přesně jak na dokladu",
  "birth_date": "YYYY-MM-DD nebo null",
  "rc": "rodné číslo s lomítkem pokud je vidět, jinak null",
  "id_document": "číslo dokladu (OP/pas) nebo null",
  "address": "adresa trvalého pobytu pokud je vidět, jinak null",
  "nationality": "CZ nebo ISO kód země, jinak null",
  "document_type": "op" | "pas" | "other" | null,
  "confidence": 0.0 až 1.0,
  "notes": "krátká poznámka pokud je něco nečitelné"
}

Pravidla:
- Pokud údaj není čitelný, dej null — nikdy nehádaj.
- Rodné číslo formátuj jako YYMMDD/XXXX pokud jde.
- Datum narození vždy YYYY-MM-DD.
- full_name: křestní jméno(a) a příjmení, bez titulů pokud možno.`;

function normalizeRc(rc) {
  const s = String(rc || '').replace(/\s/g, '');
  if (!s) return null;
  const m = s.match(/^(\d{6})\/?(\d{3,4})$/);
  if (m) return `${m[1]}/${m[2]}`;
  return s;
}

function normalizeDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function mapParsed(parsed, source) {
  const fields = {
    full_name: String(parsed.full_name || '').trim() || null,
    birth_date: normalizeDate(parsed.birth_date),
    rc: normalizeRc(parsed.rc),
    id_document: String(parsed.id_document || '').trim() || null,
    address: String(parsed.address || '').trim() || null,
    nationality: String(parsed.nationality || '')
      .trim()
      .toUpperCase()
      .slice(0, 3) || null,
    document_type: parsed.document_type || null,
  };

  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  const hasAny = Boolean(fields.full_name || fields.rc || fields.id_document || fields.birth_date);

  return {
    fields,
    confidence,
    notes: String(parsed.notes || '').trim() || null,
    source,
    stored: false,
    warning:
      'OCR je pomocník — ověřte údaje osobně podle dokladu. Fotka se neukládá, jen se jednorázově zpracuje.',
    usable: hasAny,
  };
}

export function isIdOcrConfigured() {
  return Boolean(
    String(process.env.OPENAI_API_KEY || '').trim() ||
      String(process.env.GEMINI_API_KEY || '').trim(),
  );
}

async function extractWithOpenAI(imageBase64, mimeType) {
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('OPENAI_API_KEY chybí'), { code: 'NO_OPENAI' });
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: EXTRACT_PROMPT },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(data?.error?.message || `OpenAI Vision chyba ${res.status}`),
      { status: 502, code: 'OCR_OPENAI' },
    );
  }

  const raw = data?.choices?.[0]?.message?.content || '{}';
  return mapParsed(JSON.parse(raw), 'openai-gpt4o-vision');
}

async function extractWithGemini(imageBase64, mimeType) {
  if (!process.env.GEMINI_API_KEY) {
    throw Object.assign(new Error('GEMINI_API_KEY chybí'), { code: 'NO_GEMINI' });
  }
  const model = process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: EXTRACT_PROMPT },
            { inline_data: { mime_type: mimeType, data: imageBase64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 800,
        responseMimeType: 'application/json',
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(data?.error?.message || `Gemini Vision chyba ${res.status}`),
      { status: 502, code: 'OCR_GEMINI' },
    );
  }
  const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const parsed = parseGeminiJsonText(raw);
  return mapParsed(parsed, `gemini-${model}`);
}

/**
 * @param {{ imageBase64: string, mimeType?: string }} input
 */
export async function extractIdDocumentFields(input) {
  const imageBase64 = String(input?.imageBase64 || '')
    .replace(/^data:[^;]+;base64,/, '')
    .trim();
  const mimeType = String(input?.mimeType || 'image/jpeg')
    .toLowerCase()
    .split(';')[0]
    .trim();

  if (!imageBase64) {
    throw Object.assign(new Error('Chybí fotka dokladu'), { status: 400 });
  }
  assertImagePayload(imageBase64, mimeType);

  if (!isIdOcrConfigured()) {
    throw Object.assign(
      new Error('OCR dokladu vyžaduje OPENAI_API_KEY nebo GEMINI_API_KEY na backendu.'),
      { status: 503, code: 'OCR_NOT_CONFIGURED' },
    );
  }

  const errors = [];
  if (process.env.OPENAI_API_KEY) {
    try {
      return await extractWithOpenAI(imageBase64, mimeType);
    } catch (err) {
      errors.push(err?.message || 'OpenAI selhalo');
      console.warn('[idDocumentOcr] OpenAI fallback → Gemini:', err?.message);
    }
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      return await extractWithGemini(imageBase64, mimeType);
    } catch (err) {
      errors.push(err?.message || 'Gemini selhalo');
    }
  }

  throw Object.assign(
    new Error(
      `OCR selhalo (${errors.join('; ') || 'žádný provider'}). Vyplňte údaje ručně.`,
    ),
    { status: 502, code: 'OCR_PROVIDER' },
  );
}
