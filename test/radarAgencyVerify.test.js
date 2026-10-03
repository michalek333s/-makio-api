import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSrealityHashFromUrl,
  extractSrealityHashId,
  listingNeedsAgencyVerify,
} from '../src/services/radarAgencyVerify.js';

test('extractSrealityHashFromUrl', () => {
  assert.equal(
    extractSrealityHashFromUrl(
      'https://www.sreality.cz/detail/prodej/byt/2+kk/ostrava/1234567890',
    ),
    '1234567890',
  );
  assert.equal(extractSrealityHashFromUrl('https://bazos.cz/inzerat/123'), null);
});

test('listingNeedsAgencyVerify — bazos s duplicitou na Sreality', () => {
  const listing = {
    source: 'bazos',
    isAgencyListing: false,
    url: 'https://bazos.cz/123',
    duplicateUrls: ['https://www.sreality.cz/detail/prodej/byt/2+kk/ostrava/9876543210'],
  };
  assert.equal(extractSrealityHashId(listing), '9876543210');
  assert.equal(listingNeedsAgencyVerify(listing), true);
});

test('listingNeedsAgencyVerify — už RK', () => {
  assert.equal(
    listingNeedsAgencyVerify({ source: 'bazos', isAgencyListing: true, url: 'x' }),
    false,
  );
});
