/**
 * Naplní GeoPas mezipaměť (disk + RAM + Supabase pokud žije).
 * Spuštění: node scripts/warm-geopas-cache.mjs
 *
 * Tip: doplň adresy do WARM_QUERIES podle svých lokalit (MSK / Praha…).
 */
import '../src/loadEnv.js';
import { runPropertyAnalysis } from '../src/services/runPropertyAnalysis.js';
import { searchProperty } from '../src/services/geopas.js';
import { getGeopasCacheStatsAsync } from '../src/services/geopasCacheStore.js';
import { rememberSystemLocalityProfile } from '../src/services/localityProfiles.js';
import { placeKeysFromAnalysis } from '../src/lib/localityPlaceKey.js';

const WARM_QUERIES = [
  // Frýdecko / MSK — ověřené / disambiguované tvary
  'Lískovec 310',
  'Lískovec 537',
  'Baška 50',
  'Metylovice 100',
  'Pražmo 50',
  'Morávka 100',
  'Sedliště ve Slezsku 1',
  'Smilovice u Třince 30',
  'Frýdlant nad Ostravicí Náměstí 1',
  'Frýdek-Místek Hlavní třída 1',
  'Frýdek-Místek Ostravská 1',
  'Ostrava Nádražní 1',
  'Ostrava Poruba Hlavní třída 10',
  'Ostrava Mariánské Hory Přemyslovců 1',
  'Havířov Dělnická 1',
  'Karviná 1',
  'Opava Horní náměstí 1',
  'Český Těšín Nádražní 1',
  'Kopřivnice Štefánikova 1',
  'Frenštát pod Radhoštěm Markova 1',
  'Nový Jičín Divadelní 1',
  'Třinec Těšínská 1',
  'Bocanovice 20',
  // Praha / Brno
  'Mánesova 12, Praha 2',
  'Korunní 1, Praha',
  'Masarykova 1, Brno',
  // parcely s KÚ (place-first) — vždy refresh ve warm
  '2201/1 Vinohrady',
  '2201/1 Praha Vinohrady',
  '4136/8 Lískovec',
  '4136/8 Lískovec u Frýdku-Místku',
];

const SEARCH_TERMS = [
  'Lískovec',
  'Frýdek-Místek',
  'Ostrava Poruba',
  'Vinohrady Praha',
  'Baška',
  'Sedliště ve Slezsku',
  'Smilovice Třinec',
  'Frýdlant nad Ostravicí',
  'Morávka',
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('=== GeoPas cache warm-up ===\n');

  let ok = 0;
  let fail = 0;
  const profiles = [];

  console.log('--- search ---');
  for (const term of SEARCH_TERMS) {
    try {
      const r = await searchProperty(term);
      const n = Array.isArray(r?.results) ? r.results.length : Array.isArray(r) ? r.length : 0;
      console.log(`✅ search "${term}" → ${n}${r?.fromCache ? ' (cache)' : ''}`);
      ok++;
    } catch (e) {
      console.log(`❌ search "${term}" → ${e.message}`);
      fail++;
    }
    await delay(200);
  }

  console.log('\n--- analyze ---');
  for (const q of WARM_QUERIES) {
    const t0 = Date.now();
    try {
      const refresh = /\d+\s*\/\s*\d+/.test(q);
      const a = await runPropertyAnalysis(q, { useCache: true, refresh });
      const ms = Date.now() - t0;
      const cache = a.fromCache ? `HIT ${a.cacheSource || ''}` : 'MISS→stored';
      console.log(
        `✅ ${q} → ${a.address || a.errorCode || 'ok'} | ${a.safetyScore?.mode || '?'} | ${a.localityProfile?.vibe || 'no-profile'} | ${cache} | ${ms}ms`,
      );
      ok++;
      if (a.localityProfile) {
        profiles.push({
          q,
          vibe: a.localityProfile.vibe,
          key: a.localityProfile.placeKey || placeKeysFromAnalysis(a)[0],
        });
      } else {
        // force remember from keys for known villages in query string
        const keys = placeKeysFromAnalysis(a);
        if (keys[0] && /lískovec|paskov|baška|sedliště|smilovice|morávka|metylovice|pražmo/i.test(q)) {
          await rememberSystemLocalityProfile({
            placeKey: keys[0],
            municipalityName: a.municipality?.name || q.split(/\s+\d/)[0],
            vibe: 'klidna_vesnice',
            noiseFeel: 'tiche',
            notes: `Warm-up seed z dotazu „${q}“.`,
            source: 'system',
            confidence: 'medium',
          });
        }
      }
    } catch (e) {
      console.log(`❌ ${q} → ${e.message}`);
      fail++;
    }
    await delay(350);
  }

  // second pass — should be mostly HIT
  console.log('\n--- verify HIT ---');
  let hits = 0;
  const verifyList = WARM_QUERIES.filter((q) => !/Národní 1|náměstí|Svobody/.test(q)).slice(0, 8);
  for (const q of verifyList) {
    try {
      const a = await runPropertyAnalysis(q, { useCache: true });
      if (a.fromCache) hits++;
      console.log(`${a.fromCache ? 'HIT' : 'MISS'} ${q} (${a.cacheSource || 'live'})`);
    } catch (e) {
      console.log(`SKIP ${q} → ${e.message.slice(0, 80)}`);
    }
  }

  const stats = await getGeopasCacheStatsAsync();
  console.log('\n=== STATS ===');
  console.log(JSON.stringify(stats, null, 2));
  console.log(`\nok=${ok} fail=${fail} verifyHits=${hits}/8`);
  console.log('profiles seen:', profiles.length);
  console.log('\nTip: npm run eval:accuracy — selftest přesnosti; npm run seed:locality — sync profilů.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
