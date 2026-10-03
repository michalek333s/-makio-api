/**
 * Ověření cache: node --import dotenv/config scripts/verify-geopas-cache.mjs
 */
import { runPropertyAnalysis } from '../src/services/runPropertyAnalysis.js';
import { getGeopasCacheStats } from '../src/services/geopasCacheStore.js';

const q = process.argv[2] || 'Mánesova 12 Praha';

console.log('1) První volání (může jít na GeoPas)...');
const t0 = Date.now();
const a = await runPropertyAnalysis(q, { useCache: true, refresh: false });
console.log('   fromCache:', a.fromCache, '| ms:', Date.now() - t0);

console.log('2) Druhé volání (musí být cache HIT, ~0 GeoPas)...');
const t1 = Date.now();
const b = await runPropertyAnalysis(q, { useCache: true });
console.log('   fromCache:', b.fromCache, '| source:', b.cacheSource, '| ms:', Date.now() - t1);

console.log('3) Stats:', JSON.stringify(getGeopasCacheStats(), null, 2));

if (!b.fromCache) {
  console.error('\n❌ Cache nefunguje — zkontrolujte GEOPAS_CACHE_ENABLED, migraci 0015, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}
console.log('\n✅ Cache OK');
