/**
 * Normalize any thrown / API error payload into a readable Czech-safe string.
 * Prevents UI showing "[object Object]" when providers return structured `detail`.
 */

export function stringifyError(value, fallback = 'Neznámá chyba') {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t || t === '[object Object]') return fallback;
    return t;
  }
  if (value instanceof Error) {
    return stringifyError(value.message, fallback);
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => stringifyError(v, '')).filter(Boolean);
    return parts.length ? parts.join('; ') : fallback;
  }
  if (typeof value === 'object') {
    if (typeof value.message === 'string' && value.message.trim()) {
      return value.message.trim();
    }
    if (typeof value.error === 'string' && value.error.trim()) {
      return value.error.trim();
    }
    if (typeof value.msg === 'string' && value.msg.trim()) {
      return value.msg.trim();
    }
    if (value.detail != null) {
      const d = stringifyError(value.detail, '');
      if (d) return d;
    }
    try {
      const json = JSON.stringify(value);
      if (json && json !== '{}' && json !== 'null') return json.slice(0, 400);
    } catch {
      /* ignore */
    }
  }
  const asStr = String(value);
  return asStr === '[object Object]' ? fallback : asStr;
}

export function asError(value, { status, code, fallback } = {}) {
  const msg = stringifyError(value, fallback || 'Operace selhala.');
  return Object.assign(new Error(msg), {
    ...(status != null ? { status } : {}),
    ...(code ? { code } : {}),
  });
}
