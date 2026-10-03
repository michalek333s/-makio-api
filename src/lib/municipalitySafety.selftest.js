import { mapMunicipalityStats } from '../services/geopas.js';
import { calculateSafetyScore } from '../services/scoring.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const muni = mapMunicipalityStats({
  executionRows: [{ per_hundred: 4.2 }],
  unemploymentRows: [{ unemployment_rate: 2.8 }],
  municipalityCode: 554782,
  municipalityName: 'Praha',
});
assert(muni.foreclosures.perHundred === 4.2, 'foreclosures');
assert(muni.demographics.unemploymentRate === 2.8, 'unemployment');
assert(muni.crime === null, 'crime still null');

const score = calculateSafetyScore({
  municipality: muni,
  amenities: {
    schools: [{}, {}, {}],
    transit: [{}, {}, {}, {}, {}],
    health: [{}],
  },
});
assert(score.mode === 'partial', `expected partial got ${score.mode}`);
assert(score.score != null && score.score > 0, 'score number');
assert(score.missingInputs.includes('crime'), 'crime missing');
assert(!score.missingInputs.includes('foreclosures'), 'foreclosures present');
assert(score.inputsUsed.includes('socio') && score.inputsUsed.includes('amenities'), 'pillars');

const amenitiesOnly = calculateSafetyScore({
  municipality: null,
  amenities: { schools: [{}], transit: [{}], health: [] },
});
assert(amenitiesOnly.mode === 'amenities_only', amenitiesOnly.mode);

console.log('municipalitySafety.selftest OK', { partial: score.score, mode: score.mode });
