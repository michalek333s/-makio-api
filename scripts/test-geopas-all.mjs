/**
 * Kompletní test GeoPas endpointů + analýza.
 * node --import dotenv/config scripts/test-geopas-all.mjs "Lískovec 310 Frýdek-Místek"
 */
import { runPropertyAnalysis } from '../src/services/runPropertyAnalysis.js';

const query = process.argv[2] || 'Lískovec 310 Frýdek-Místek';

console.log('GeoPas full test:', query);
const r = await runPropertyAnalysis(query, { useCache: false, refresh: true });

console.log('\n=== Výsledek ===');
console.log('Adresa:', r.address);
console.log('Katastr:', r.ku);
console.log('Výměra:', r.area, `(${r.areaSqm} m²)`);
console.log('LV:', r.lv);
console.log('Vlastník:', r.owner, r.isTestOwner ? '(test)' : '');
console.log('Owners:', r.owners?.join(', '));
console.log('Safety:', r.safetyScore?.score);
console.log('Záplavy:', r.risks?.flood);
console.log('Radon:', r.risks?.radon);
console.log('Odhad:', r.valuation?.realistic);

console.log('\n=== Endpointy ===');
for (const ep of r.endpointStatus || []) {
  const icon = ep.ok && !ep.empty ? '✅' : ep.ok ? '⚠️' : '❌';
  console.log(`${icon} ${ep.name}${ep.ms ? ` (${ep.ms}ms)` : ''}${ep.error ? ` — ${ep.error}` : ''}`);
}

const failed = (r.endpointStatus || []).filter((e) => !e.ok);
if (failed.length) {
  console.log('\n❌ Selhalo:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
console.log('\n✅ GeoPas analýza OK');
