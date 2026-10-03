/**
 * Fail-closed start v production. Lokální development se nemění.
 */
import { isAuthEnforced } from '../middleware/requireAuth.js';
import { resolveCorsOrigin } from './corsOrigin.js';

function isProd(nodeEnv = process.env.NODE_ENV) {
  return String(nodeEnv || '').toLowerCase() === 'production';
}

function envFlag(env, name) {
  return ['1', 'true', 'yes'].includes(String(env[name] || '').trim().toLowerCase());
}

export function collectProductionGuardErrors(env = process.env) {
  if (!isProd(env.NODE_ENV)) return [];

  const errors = [];
  if (envFlag(env, 'AUTH_DISABLED')) errors.push('AUTH_DISABLED je v production zakázaný');
  if (envFlag(env, 'AUTH_ALLOW_ANON_DEV')) errors.push('AUTH_ALLOW_ANON_DEV je v production zakázaný');
  if (envFlag(env, 'RADAR_DEMO_FALLBACK')) errors.push('RADAR_DEMO_FALLBACK musí být v production vypnutý');

  if (!String(env.SUPABASE_URL || '').trim() || !String(env.SUPABASE_ANON_KEY || '').trim()) {
    errors.push('Chybí SUPABASE_URL / SUPABASE_ANON_KEY — auth nelze vynutit');
  }
  if (!String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()) {
    errors.push('Chybí SUPABASE_SERVICE_ROLE_KEY — CRM a waitlist v production nepoběží');
  }

  const cors = resolveCorsOrigin({
    nodeEnv: env.NODE_ENV,
    frontendUrl: env.FRONTEND_URL,
    frontendUrls: env.FRONTEND_URLS,
  });
  if (cors === false) {
    errors.push('Chybí FRONTEND_URL / FRONTEND_URLS (např. https://app.makio.cz,https://makio.cz)');
  }

  return errors;
}

/** Volat před app.listen. V production při chybě process.exit(1). */
export function assertProductionGuards() {
  const errors = collectProductionGuardErrors();
  if (!errors.length) {
    if (isProd() && isAuthEnforced()) {
      console.log('   Production guards: ✅ auth, CORS, bez Radar dema');
    }
    return { ok: true, errors: [] };
  }
  console.error('[production] Start zastaven:');
  for (const e of errors) console.error(`   • ${e}`);
  process.exit(1);
}
