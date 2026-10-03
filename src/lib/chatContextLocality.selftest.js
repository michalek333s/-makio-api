/**
 * Selftest — kontext lokality z historie chatu.
 */
import assert from 'node:assert/strict';
import {
  referencesContextualLocality,
  isContextualMarketQuery,
  resolveLocalityFromChatHistory,
} from './chatContextLocality.js';
import { isRadarMarketQuery } from './chatIntent.js';

const history = [
  { role: 'user', text: 'zjisti mi o lokalite repiste' },
  {
    role: 'ai',
    text: 'Ahoj Michale, jasně, mrkneme na **Řepiště**. Klidná obec mezi Ostravou a Frýdkem…',
    parsedData: { municipalityName: 'Řepiště', intent: 'locality_info' },
  },
];

assert(referencesContextualLocality('najdi nejake pozemky v teto lokalite'));
assert(resolveLocalityFromChatHistory(history) === 'Řepiště');
assert(isContextualMarketQuery('najdi nejake pozemky v teto lokalite', history));
assert(isRadarMarketQuery('najdi nejake pozemky v teto lokalite', history));
assert(!isRadarMarketQuery('najdi nejake pozemky v teto lokalite', []));

console.log('chatContextLocality.selftest.js OK');
