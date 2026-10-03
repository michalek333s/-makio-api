import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dHashFromGrayPixels,
  findPHashMatch,
  hammingDistance,
  hashesOf,
} from '../src/services/radarPHash.js';
import { evaluateListing } from '../src/lib/radar/deduplication.js';
import {
  collectNearbyAgencyReferences,
  queryNearbyAgencyListings,
} from '../src/services/radarPostgisMatch.js';
import { RADAR_STATUS } from '../src/services/radarValidate.js';

test('dHashFromGrayPixels + hamming', () => {
  const pixels = new Array(9 * 8).fill(128);
  pixels[0] = 200;
  pixels[1] = 10;
  const h = dHashFromGrayPixels(pixels);
  assert.equal(h.length, 16);
  assert.equal(hammingDistance(h, h), 0);

  const flipped = pixels.slice();
  flipped[1] = 250;
  const h2 = dHashFromGrayPixels(flipped);
  assert.ok(hammingDistance(h, h2) >= 1);
  assert.ok(hammingDistance(h, h2) <= 8);
});

test('findPHashMatch s image_hashes poli', () => {
  const listing = { imageHashes: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'] };
  const refs = [
    {
      listingId: 'rk-arr',
      url: 'https://www.sreality.cz/detail/arr',
      agency_name: 'M&M',
      image_hashes: ['aaaaaaaaaaaaaaab'],
    },
  ];
  const match = findPHashMatch(listing, refs);
  assert.equal(match.listingId, 'rk-arr');
  assert.equal(match.distance, 1);
  assert.deepEqual(hashesOf(listing).length, 2);
});

test('evaluateListing / PostGIS skip když RADAR_POSTGIS_MATCH=0', async () => {
  const prev = process.env.RADAR_POSTGIS_MATCH;
  process.env.RADAR_POSTGIS_MATCH = '0';
  const orig = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => [] };
  };
  try {
    const nearby = await queryNearbyAgencyListings({ lat: 49.83, lng: 18.28, price: 2_500_000 });
    assert.deepEqual(nearby, []);
    const collected = await collectNearbyAgencyReferences([
      { lat: 49.83, lng: 18.28, price: 2_500_000, floorArea: 50, layout: '2+kk' },
    ]);
    assert.deepEqual(collected, []);
    assert.equal(fetchCalls, 0);

    const r = await evaluateListing(
      {
        source: 'bazos',
        title: 'Prodám 2+kk Poruba, přímý majitel, RK nevolat, bez provize',
        url: 'https://reality.bazos.cz/inzerat/pg-skip',
        locality: 'Ostrava, Poruba',
        phone: '608123123',
        lat: 49.83,
        lng: 18.28,
      },
      { hashImages: false },
    );
    assert.equal(r.status, RADAR_STATUS.NEW_PRIVATE);
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = orig;
    if (prev === undefined) delete process.env.RADAR_POSTGIS_MATCH;
    else process.env.RADAR_POSTGIS_MATCH = prev;
  }
});
