import rateLimit from 'express-rate-limit';

const isProd = process.env.NODE_ENV === 'production';

function isLoopback(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.endsWith('127.0.0.1')
  );
}

function intFromEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Přísnější než globální — AI endpointy jsou drahé a musí být chráněné */
export const aiRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Příliš mnoho AI požadavků. Zkuste to za minutu.' },
});

/** Vyplnění smluv (upload .docx) — ochrana před zahlcením */
export const contractRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: intFromEnv('CONTRACT_RATE_LIMIT_MAX', isProd ? 30 : 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Příliš mnoho vyplnění smluv za minutu. Zkuste to za chvíli.' },
});

/** Radar = Apify + desítky Gemini volání — přísný limit na IP */
export const radarRouteLimiter = rateLimit({
  // Produkce: bezpečný limit. Development: výchozí bypass (neblokuje lokální testy).
  windowMs: intFromEnv('RADAR_RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  max: intFromEnv('RADAR_RATE_LIMIT_MAX', isProd ? 12 : 1000),
  skip: (req) =>
    (!isProd && process.env.RADAR_RATE_LIMIT_DEV_BYPASS !== '0') || isLoopback(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limit radarových skenů za hodinu vyčerpán. Zkuste to později.' },
});
