import { LIMITS } from '../config/limits.js';

export function assertMaxLen(str, max, fieldName = 'pole') {
  if (str == null) return;
  const s = typeof str === 'string' ? str : String(str);
  if (s.length > max) {
    const err = new Error(`${fieldName}: překročena maximální délka (${max} znaků).`);
    err.status = 400;
    throw err;
  }
}

export function assertImagePayload(imageBase64, mimeType) {
  assertMaxLen(imageBase64, LIMITS.IMAGE_BASE64_MAX_CHARS, 'imageBase64');
  const mt = (mimeType || 'image/jpeg').toLowerCase().split(';')[0].trim();
  if (!LIMITS.IMAGE_MIME_WHITELIST.has(mt)) {
    const err = new Error(`Nepodporovaný typ obrázku: ${mt}`);
    err.status = 400;
    throw err;
  }
}

export function trimHistory(history, maxItems) {
  if (!Array.isArray(history)) return [];
  return history.slice(-maxItems);
}
