/**
 * Supabase JWT gate for /api/*.
 * Verifies access token via Auth API (no extra deps).
 *
 * Public by default: /api/health, /api/waitlist, /api/reels/studio/status
 * Disable entirely: AUTH_DISABLED=1
 * Dev escape (no Bearer): AUTH_ALLOW_ANON_DEV=1 (never in production)
 */

const PUBLIC_PREFIXES = [
  '/api/health',
  '/api/waitlist',
  '/api/reels/studio/status',
  '/api/webhooks/radar',
  '/api/calendar/google/callback',
  '/api/calendar/google/webhook',
];

const userCache = new Map();
/** Delší cache = méně roundtripů na Supabase Auth (méně falešných „session vypršela“). */
const CACHE_TTL_MS = 10 * 60 * 1000;
const AUTH_FETCH_TIMEOUT_MS = 15_000;

export function isAuthEnforced() {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const anon = String(process.env.SUPABASE_ANON_KEY || '').trim();
  const configured = Boolean(url && anon);

  if (process.env.AUTH_DISABLED === '1' || process.env.AUTH_DISABLED === 'true') {
    if (process.env.NODE_ENV === 'production') {
      console.error(
        '[auth] AUTH_DISABLED je v production zakázán — JWT zůstává povinný (pokud je Supabase nastaven).',
      );
      return configured;
    }
    return false;
  }

  return configured;
}

export function isPublicApiPath(reqOrPath) {
  const raw =
    typeof reqOrPath === 'string'
      ? reqOrPath
      : String(reqOrPath?.originalUrl || reqOrPath?.path || '');
  const p = raw.split('?')[0];
  // Mounted at /api → path may be /health instead of /api/health
  const candidates = [p];
  if (p.startsWith('/api/')) candidates.push(p.slice(4));
  else if (!p.startsWith('/api')) candidates.push(`/api${p.startsWith('/') ? p : `/${p}`}`);
  return candidates.some((c) =>
    PUBLIC_PREFIXES.some((prefix) => c === prefix || c.startsWith(`${prefix}/`)),
  );
}

function cacheGet(token) {
  const hit = userCache.get(token);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    userCache.delete(token);
    return null;
  }
  return hit.user;
}

function cacheSet(token, user) {
  userCache.set(token, { user, expiresAt: Date.now() + CACHE_TTL_MS });
  if (userCache.size > 500) {
    const first = userCache.keys().next().value;
    userCache.delete(first);
  }
}

/** Decode JWT payload without verify — jen exp/sub pro rychlou diagnostiku. */
function peekJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * @returns {{ user: object|null, code?: string, status?: number, error?: string }}
 */
async function resolveSupabaseUser(accessToken) {
  const cached = cacheGet(accessToken);
  if (cached) return { user: cached };

  const payload = peekJwtPayload(accessToken);
  if (!payload?.sub) {
    return {
      user: null,
      status: 401,
      code: 'AUTH_INVALID',
      error: 'Neplatný access token.',
    };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < nowSec - 30) {
    return {
      user: null,
      status: 401,
      code: 'AUTH_EXPIRED',
      error: 'Access token vypršel. Obnovuji session… přihlaste se znovu, pokud to nepomůže.',
    };
  }

  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const anon = String(process.env.SUPABASE_ANON_KEY || '').trim();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: anon,
      },
      signal: controller.signal,
    });
    clearTimeout(t);

    if (res.status === 401 || res.status === 403) {
      return {
        user: null,
        status: 401,
        code: 'AUTH_INVALID',
        error: 'Neplatná nebo vypršená session. Přihlaste se znovu.',
      };
    }
    if (!res.ok) {
      console.warn('[auth] Supabase /auth/v1/user', res.status);
      return {
        user: null,
        status: 503,
        code: 'AUTH_UPSTREAM',
        error: 'Auth služba dočasně neodpovídá. Zkuste to za chvíli znovu (nejde o odhlášení).',
      };
    }

    const user = await res.json().catch(() => null);
    if (!user?.id) {
      return {
        user: null,
        status: 401,
        code: 'AUTH_INVALID',
        error: 'Neplatná session.',
      };
    }
    const normalized = {
      id: user.id,
      email: user.email || null,
      role: user.role || 'authenticated',
    };
    cacheSet(accessToken, normalized);
    return { user: normalized };
  } catch (err) {
    clearTimeout(t);
    const aborted = err?.name === 'AbortError';
    console.warn('[auth] Supabase user fetch failed:', aborted ? 'timeout' : err.message);
    return {
      user: null,
      status: 503,
      code: 'AUTH_UPSTREAM',
      error: aborted
        ? 'Auth timeout — Supabase neodpověděl včas. Zkuste znovu (session nemusí být mrtvá).'
        : 'Nelze ověřit session (síť). Zkuste znovu za chvíli.',
    };
  }
}

/**
 * Express middleware — attach req.user or 401/503.
 */
export async function requireAuth(req, res, next) {
  if (!isAuthEnforced() || isPublicApiPath(req)) {
    return next();
  }

  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();

  if (!token) {
    const allowAnonDev =
      process.env.NODE_ENV !== 'production' &&
      (process.env.AUTH_ALLOW_ANON_DEV === '1' || process.env.AUTH_ALLOW_ANON_DEV === 'true');
    if (allowAnonDev) {
      req.user = null;
      return next();
    }
    return res.status(401).json({
      error: 'Přihlášení vyžadováno. Chybí Authorization Bearer token.',
      code: 'AUTH_REQUIRED',
    });
  }

  const result = await resolveSupabaseUser(token);
  if (!result.user) {
    return res.status(result.status || 401).json({
      error: result.error || 'Neplatná session.',
      code: result.code || 'AUTH_INVALID',
    });
  }

  req.user = result.user;
  return next();
}
