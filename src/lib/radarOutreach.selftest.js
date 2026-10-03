/**
 * node src/lib/radarOutreach.selftest.js
 */
import assert from 'node:assert/strict';
import { getOutreachPolicy, canColdCallListing, listingHasRkNoCall, OUTREACH } from './radarOutreach.js';

assert.equal(getOutreachPolicy('bezrealitky').level, OUTREACH.FORBIDDEN);
assert.equal(canColdCallListing({ source: 'bezrealitky' }), false);
assert.equal(canColdCallListing({ source: 'sreality', title: 'Byt Ostrava' }), true);
assert.equal(canColdCallListing({ source: 'sreality', title: 'RK nevolat' }), true);
assert.equal(listingHasRkNoCall({ title: 'Byt, RK nevolat' }), true);
assert.equal(listingHasRkNoCall({ title: 'Byt Ostrava' }), false);
assert.equal(getOutreachPolicy('sreality').level, OUTREACH.ALLOW);
assert.equal(getOutreachPolicy('bazos').level, OUTREACH.CAUTION);
console.log('radarOutreach.selftest OK');
