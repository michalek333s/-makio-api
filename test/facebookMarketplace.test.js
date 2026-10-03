import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFacebookListing,
  unwrapFacebookDatasetItems,
} from '../src/services/facebookMarketplace.js';
import { mergeRadarAiScore } from '../src/services/radarAiScore.js';
import {
  finishNormalizedListing,
  parsePriceCzk,
} from '../src/lib/radarNormalize.js';

const APIFY_FB = {
  id: '241812345678901',
  marketplace_listing_title: 'Prodám byt 3+1 Poruba, družstevní',
  listing_price: {
    amount: '3450000',
    currency: 'CZK',
    formatted_amount: '3 450 000 Kč',
    amount_with_offset_in_currency: '345000000',
  },
  location: {
    latitude: 49.826,
    longitude: 18.171,
    reverse_geocode: {
      city: 'Ostrava',
      city_page: { display_name: 'Ostrava, Moravskoslezský kraj' },
    },
  },
  primary_listing_photo: {
    image: { uri: 'https://scontent.xx/v/t1/photo.jpg' },
  },
  listingPhotos: [{ image: { uri: 'https://scontent.xx/v/t1/photo2.jpg' } }],
  description: 'Hezký byt 72 m², 3+1, družstvo, bez RK.',
};

test('Apify Facebook shape → skutečný titulek, cena, lokalita', () => {
  const n = normalizeFacebookListing(APIFY_FB);
  assert.ok(n);
  assert.notEqual(n.title, 'Facebook Marketplace');
  assert.match(n.title, /3\+1|Poruba|byt/i);
  assert.equal(n.price, 3_450_000);
  assert.equal(typeof n.locality, 'string');
  assert.match(n.locality, /Ostrava/);
  assert.equal(n.source, 'facebook');
  assert.ok(n.imageUrl.startsWith('https://'));
  assert.equal(n.layout, '3+1');
  assert.equal(n.floorArea, 72);
});

test('unwrapFacebookDatasetItems z obalu query[]', () => {
  const rows = unwrapFacebookDatasetItems({ query: [APIFY_FB] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].marketplace_listing_title, APIFY_FB.marketplace_listing_title);
});

test('prodané a area_summary se zahodí', () => {
  assert.equal(normalizeFacebookListing({ ...APIFY_FB, is_sold: true }), null);
  assert.equal(normalizeFacebookListing({ type: 'area_summary', count: 12 }), null);
  assert.equal(normalizeFacebookListing({ id: 'x' }), null);
});

test('generický titulek se složí z ceny a města', () => {
  const n = normalizeFacebookListing({
    id: '9',
    title: 'Facebook Marketplace',
    listing_price: { amount: '2100000' },
    location: { reverse_geocode: { city: 'Karviná' } },
  });
  assert.ok(n);
  assert.notEqual(n.title, 'Facebook Marketplace');
  assert.match(n.title, /Karviná|2\s*100\s*000|Nabídka/);
});

test('parsePriceCzk z Facebook listing_price objektu', () => {
  assert.equal(parsePriceCzk({ amount: '3450000' }), 3_450_000);
  assert.equal(
    parsePriceCzk({ formatted_amount: '3 450 000 Kč', amount: '3450000' }),
    3_450_000,
  );
  assert.equal(parsePriceCzk({ amount_with_offset_in_currency: '345000000' }), 3_450_000);
});

test('finishNormalizedListing opraví cache s placeholder titulkem', () => {
  const salvaged = finishNormalizedListing({
    source: 'facebook',
    title: 'Facebook Marketplace',
    price: { amount: '1800000' },
    locality: { reverse_geocode: { city: 'Frýdek-Místek' } },
  });
  assert.notEqual(salvaged.title, 'Facebook Marketplace');
  assert.equal(salvaged.price, 1_800_000);
  assert.match(String(salvaged.locality), /Frýdek-Místek/);
});

test('mergeRadarAiScore nenechá FSBO Facebook na 0 kvůli chudému titulku', () => {
  const listing = { source: 'facebook', isAgencyListing: false };
  const gemini = { score: 0, label: 'Zastoupeno RK', reasons: ['Obecný titulek'] };
  const heuristic = { score: 67, label: 'Dobrý náběr', reasons: ['Facebook Marketplace'] };
  const merged = mergeRadarAiScore(listing, gemini, heuristic);
  assert.equal(merged.score, 67);
  assert.match(merged.reasons.join(' '), /podhodnotila|náběrové/i);
});

test('mergeRadarAiScore nechá Gemini, když heuristika není silná', () => {
  const listing = { source: 'facebook', isAgencyListing: false };
  const gemini = { score: 8, label: 'Slabé' };
  const heuristic = { score: 20, label: 'Nízko' };
  assert.equal(mergeRadarAiScore(listing, gemini, heuristic).score, 8);
});
