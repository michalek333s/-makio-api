import {
  extractPropertyQuery,
  normalizePropertyQuery,
  looksLikePropertyQuestion,
} from './extractPropertyQuery.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const cases = [
  ['Analyzuj Mánesovu 12, Praha 2', 'Mánesova 12, Praha 2'],
  ['Analyzuj Mánesova 12, Praha 2', 'Mánesova 12, Praha 2'],
  ['Jsou záplavy u Nádražní 1 Ostrava?', 'Nádražní 1 Ostrava'],
  ['Jaký je radon u Korunní 1 Praha?', 'Korunní 1 Praha'],
  ['Zjisti LV pro parcelu 2201/1 Vinohrady', '2201/1 Vinohrady'],
  ['Lískovec 537', 'Lískovec 537'],
];

for (const [input, expect] of cases) {
  const got = extractPropertyQuery(input);
  const normExpect = normalizePropertyQuery(expect);
  assert(
    got &&
      got.toLowerCase().includes(normExpect.split(',')[0].toLowerCase().split(/\s+\d/)[0].slice(0, 6)),
    `${input} → got "${got}", expected like "${expect}"`,
  );
  console.log('OK', input, '→', got);
}

assert(looksLikePropertyQuestion('Jsou záplavy u Nádražní 1 Ostrava?'), 'looksLike flood');
console.log('extractPropertyQuery.selftest OK');
