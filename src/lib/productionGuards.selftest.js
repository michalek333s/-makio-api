import assert from 'node:assert/strict';
import { collectProductionGuardErrors } from './productionGuards.js';

assert.deepEqual(collectProductionGuardErrors({ NODE_ENV: 'development' }), []);

const prodBase = {
  NODE_ENV: 'production',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  FRONTEND_URL: 'https://app.makio.cz',
  FRONTEND_URLS: 'https://app.makio.cz,https://makio.cz',
};
assert.equal(collectProductionGuardErrors(prodBase).length, 0);

assert.ok(
  collectProductionGuardErrors({ ...prodBase, AUTH_DISABLED: '1' }).some((e) =>
    e.includes('AUTH_DISABLED'),
  ),
);
assert.ok(
  collectProductionGuardErrors({ ...prodBase, RADAR_DEMO_FALLBACK: '1' }).some((e) =>
    e.includes('RADAR_DEMO_FALLBACK'),
  ),
);
assert.ok(
  collectProductionGuardErrors({
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
  }).some((e) => e.includes('FRONTEND_URL')),
);

console.log('productionGuards.selftest ok');
