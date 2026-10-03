import {
  looksLikeLocalityInfoQuery,
  extractLocalityNameFromMessage,
} from './localityInfoQuery.js';
import {
  extractPropertyQuery,
  hasConcretePropertyTarget,
  looksLikePropertyQuestion,
} from './extractPropertyQuery.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const localityMsg = 'zjisti mi info o lokalite lískovec u frýdku místku';
assert(looksLikeLocalityInfoQuery(localityMsg), 'locality info detect');
assert(
  extractLocalityNameFromMessage(localityMsg)?.toLowerCase().includes('lískovec'),
  'extract locality name',
);
assert(!extractPropertyQuery(localityMsg), 'no property query for locality info');
assert(!hasConcretePropertyTarget(localityMsg, {}), 'no geopas for locality info');
assert(!looksLikePropertyQuestion(localityMsg), 'not property question');

assert(hasConcretePropertyTarget('Lískovec 310', {}), 'concrete cp');
assert(hasConcretePropertyTarget('2201/1 Vinohrady', {}), 'concrete parcel');
assert(!hasConcretePropertyTarget('co víš o lokalitě lískovec', {}), 'general locality no geopas');

assert(looksLikeLocalityInfoQuery('analyzuj lokalitu Lískovec'), 'analyzuj lokalitu');
assert(looksLikeLocalityInfoQuery('jak to je ve frýdku-místku?'), 'jak to je ve');
assert(looksLikeLocalityInfoQuery('je bezpečná lokalita Baška?'), 'bezpečná lokalita');
assert(looksLikeLocalityInfoQuery('info lískovec'), 'info obec');
assert(looksLikeLocalityInfoQuery('kde je lepší bydlet — Řepiště nebo Baška?'), 'srovnání obcí');
assert(!looksLikeLocalityInfoQuery('co víš o Safety Score?'), 'Safety Score not locality');

console.log('localityInfoQuery.selftest OK');
