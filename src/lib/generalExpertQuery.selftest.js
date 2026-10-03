import assert from 'node:assert/strict';
import { isGeneralExpertQuery } from './generalExpertQuery.js';
import {
  looksLikePropertyQuestion,
  extractPropertyQuery,
  hasConcretePropertyTarget,
} from './extractPropertyQuery.js';
import { isGeopasChatMessage } from './isGeopasChatMessage.js';
import { isRadarMarketQuery } from './chatIntent.js';
import { looksLikeLocalityInfoQuery } from './localityInfoQuery.js';

const expert = 'jak poznám vzlínající vlhkost u cihlového domu z 30. let?';

assert(isGeneralExpertQuery(expert), 'expert query detected');
assert(!looksLikePropertyQuestion(expert), 'not property question');
assert.strictEqual(extractPropertyQuery(expert), null, 'no extract');
assert(!isGeopasChatMessage(expert), 'no geopas route');
assert(!hasConcretePropertyTarget(expert, {}), 'no concrete target');

assert(hasConcretePropertyTarget('Lískovec 310', {}), 'real address still works');
assert(extractPropertyQuery('2201/1 Vinohrady'), '2201/1 Vinohrady');

const radonAddr = 'Jaký je radon u Korunní 1 Praha?';
assert(!isGeneralExpertQuery(radonAddr), 'radon at address is NOT general expert');
assert(looksLikePropertyQuestion(radonAddr), 'radon at address IS property question');
assert(extractPropertyQuery(radonAddr), 'radon address extracted');

// Bug fixes
assert(isGeneralExpertQuery('kolik stojí 3+kk ve Frýdku?'), '3+kk price = expert');
assert(!isGeopasChatMessage('kolik stojí 3+kk ve Frýdku?'), '3+kk not geopas');
assert(!hasConcretePropertyTarget('kolik stojí 3+kk ve Frýdku?', {}), '3+kk not concrete');
assert.strictEqual(extractPropertyQuery('kolik stojí 3+kk ve Frýdku?'), null, '3+kk no extract');

assert(isGeneralExpertQuery('porovnej Porotherm a Ytong'), 'materials = expert');
assert(!isRadarMarketQuery('porovnej Porotherm a Ytong'), 'materials not radar');

assert(isGeneralExpertQuery('jak nastavit nabídkovou cenu 3+kk Ostrava?'), 'pricing = expert');
assert(!isRadarMarketQuery('jak nastavit nabídkovou cenu 3+kk Ostrava?'), 'pricing not radar');

assert(isGeneralExpertQuery('má smysl koupit investiční byt?'), 'invest advice = expert');
assert(!isRadarMarketQuery('má smysl koupit investiční byt?'), 'invest advice not radar');

assert(isGeneralExpertQuery('jaká je daň z příjmu při prodeji po 4 letech?'), 'tax = expert');
assert(!hasConcretePropertyTarget('jaká je daň z příjmu při prodeji po 4 letech?', {}), 'tax not address');

assert(isGeneralExpertQuery('co je Safety Score?'), 'safety score = expert');
assert(!looksLikeLocalityInfoQuery('co je Safety Score?'), 'safety score not locality');

assert(!isGeopasChatMessage('zkontroluj LV'), 'LV alone not geopas');

console.log('generalExpertQuery.selftest.js OK');
