/**
 * Rychlý test GeoPas: node scripts/test-geopas.mjs "Mánesova 12 Praha"
 * Vyžaduje GEOPAS_API_KEY (+ volitelně GEOPAS_DEV_IP) v nemio-backend/.env
 */
import 'dotenv/config';
import { entityByTerm } from '../src/services/geopas.js';

const term = process.argv[2] || 'Mánesova 12 Praha';
const key = process.env.GEOPAS_API_KEY?.trim();

if (!key) {
  console.error('❌ GEOPAS_API_KEY je prázdný v nemio-backend/.env — vložte token a uložte soubor.');
  process.exit(1);
}

console.log('GeoPas test:', term);
console.log('DEV_IP:', process.env.GEOPAS_DEV_IP || '(produkce geopas.cz)');

try {
  const rows = await entityByTerm(term, 'address,land');
  console.log('✅ Odpověď OK, záznamů:', rows?.length ?? 0);
  if (rows?.[0]) console.log('První hit:', JSON.stringify(rows[0], null, 2).slice(0, 500));
} catch (e) {
  console.error('❌', e.message);
  process.exit(1);
}
