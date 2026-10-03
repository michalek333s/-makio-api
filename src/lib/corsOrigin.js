/**
 * CORS origin resolver — supports one URL or comma-separated FRONTEND_URL / FRONTEND_URLS.
 */

export function resolveCorsOrigin({
  nodeEnv = process.env.NODE_ENV,
  frontendUrl = process.env.FRONTEND_URL,
  frontendUrls = process.env.FRONTEND_URLS,
} = {}) {
  const isProd = String(nodeEnv || '').toLowerCase() === 'production';
  if (!isProd) return true;

  const raw = [frontendUrls, frontendUrl]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const unique = [...new Set(raw)];
  if (!unique.length) return false;
  if (unique.length === 1) return unique[0];

  return (origin, callback) => {
    if (!origin) return callback(null, true);
    const normalized = String(origin).replace(/\/$/, '');
    if (unique.includes(normalized)) return callback(null, true);
    return callback(new Error(`CORS blocked: ${origin}`));
  };
}
