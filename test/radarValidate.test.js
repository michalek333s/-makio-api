import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeSourceUrl,
  extractCity,
  localityToString,
  finishNormalizedListing,
  extractCzPhones,
  normalizeCzPhone,
  parseFloorArea,
  parseLayout,
  parsePriceCzk,
} from '../src/lib/radarNormalize.js';
import { hammingDistance, isPHashDuplicate, findPHashMatch } from '../src/services/radarPHash.js';
import {
  computeMatchScore,
  findRkKeywords,
  findOwnerSignals,
  multiplicityIsBroker,
  validateRadarListing,
  RADAR_STATUS,
  MATCH_THRESHOLDS,
} from '../src/services/radarValidate.js';
import { ingestRadarListing } from '../src/services/radarIngest.js';

test('normalizeCzPhone E.164', () => {
  assert.equal(normalizeCzPhone('777 123 456'), '+420777123456');
  assert.equal(normalizeCzPhone('+420 777 123 456'), '+420777123456');
  assert.equal(normalizeCzPhone('00420777123456'), '+420777123456');
  assert.equal(normalizeCzPhone('420777123456'), '+420777123456');
  assert.equal(normalizeCzPhone('123'), null);
  assert.equal(normalizeCzPhone(''), null);
});

test('extractCzPhones z textu inzerátu', () => {
  const phones = extractCzPhones('Volat na 777 123 456 nebo +420 608 111 222. RK nevolat.');
  assert.ok(phones.includes('+420777123456'));
  assert.ok(phones.includes('+420608111222'));
});

test('parsePrice / area / layout / URL / město', () => {
  assert.equal(parsePriceCzk('3 450 000 Kč'), 3_450_000);
  assert.equal(parsePriceCzk({ amount: '3450000' }), 3_450_000);
  assert.equal(localityToString({ reverse_geocode: { city: 'Ostrava' } }), 'Ostrava');
  assert.equal(parseFloorArea(null, 'Byt 71 m² v Ostravě'), 71);
  assert.equal(parseLayout(null, 'Prodej bytu 2+kk, Poruba'), '2+kk');
  assert.equal(parseLayout('3 + 1'), '3+1');
  assert.equal(
    canonicalizeSourceUrl('https://www.bazos.cz/inzerat/1/?utm_source=x#frag'),
    'https://www.bazos.cz/inzerat/1',
  );
  assert.equal(extractCity('Ostrava, Poruba'), 'Ostrava');
  assert.equal(localityToString({ value: 'Ostrava - Poruba' }), 'Ostrava - Poruba');
  assert.equal(extractCity({ value: 'Karviná, Fryštát' }), 'Karviná');
  const coerced = finishNormalizedListing({
    title: 'Byt',
    locality: { value: 'Ostrava, Poruba', entity_id: 1 },
    url: 'https://www.bazos.cz/inzerat/1',
  });
  assert.equal(typeof coerced.locality, 'string');
  assert.equal(coerced.locality, 'Ostrava, Poruba');
});

test('RK keywords vs owner signals', () => {
  assert.ok(findRkKeywords('Provize 4 %, zastoupení majitele, ID zakázky 12').length >= 3);
  assert.ok(findRkKeywords('Exkluzivně nabízíme, kancelář na náměstí').length >= 2);
  assert.ok(findOwnerSignals('Přímý majitel, bez provize, RK nevolat').length >= 3);
  assert.equal(findRkKeywords('Hezký byt v klidné ulici').length, 0);
  assert.equal(findRkKeywords('Prodej bytu 2+1 — bez RK').length, 0);
});

test('multiplicitní telefon >3 města / 30 dní', () => {
  const recent = [
    { city: 'Ostrava', listingId: 'a', scrapedAt: new Date().toISOString() },
    { city: 'Brno', listingId: 'b', scrapedAt: new Date().toISOString() },
    { city: 'Praha', listingId: 'c', scrapedAt: new Date().toISOString() },
    { city: 'Plzeň', listingId: 'd', scrapedAt: new Date().toISOString() },
  ];
  const hit = multiplicityIsBroker('+420777000001', recent);
  assert.equal(hit.isBroker, true);
  assert.equal(hit.distinctCities, 4);

  const few = multiplicityIsBroker('+420777000001', recent.slice(0, 2));
  assert.equal(few.isBroker, false);
});

test('MatchScore: plocha ±5, cena ±10 %, dispozice, 500 m', () => {
  const listing = {
    floorArea: 70,
    price: 3_000_000,
    layout: '2+kk',
    lat: 49.834,
    lon: 18.282,
  };
  const close = {
    floorArea: 73,
    price: 3_200_000,
    layout: '2+kk',
    lat: 49.835,
    lon: 18.283,
    listingId: 'rk-1',
    url: 'https://www.sreality.cz/detail/1',
  };
  const m = computeMatchScore(listing, close);
  assert.ok(m.score >= MATCH_THRESHOLDS.duplicateScore, m.score);
  assert.equal(m.parts.area, 1);
  assert.equal(m.parts.price, 1);
  assert.equal(m.parts.layout, 1);
  assert.equal(m.parts.geo, 1);

  const far = { ...close, lat: 50.1, lon: 14.4, price: 8_000_000, floorArea: 120, layout: '4+1' };
  const m2 = computeMatchScore(listing, far);
  assert.ok(m2.score < 0.3, m2.score);
});

test('pHash Hamming ≤ 8 = duplicita', () => {
  const a = 'ffffffffffffffff';
  const b = 'fffffffffffffffe';
  assert.equal(hammingDistance(a, b), 1);
  assert.equal(isPHashDuplicate(a, b, 8), true);

  const far = '0000000000000000';
  assert.equal(hammingDistance(a, far), 64);
  assert.equal(isPHashDuplicate(a, far, 8), false);

  const match = findPHashMatch(a, [{ photoPHash: b, listingId: 'sreality-9', url: 'https://sreality.cz/x' }]);
  assert.equal(match.listingId, 'sreality-9');
  assert.equal(match.distance, 1);
});

test('validateRadarListing: blacklist → SUSPECTED_BROKER', () => {
  const r = validateRadarListing(
    { title: 'Byt 2+kk Ostrava', phone: '777111222', source: 'bazos' },
    { blacklist: ['+420777111222'] },
  );
  assert.equal(r.status, RADAR_STATUS.SUSPECTED_BROKER);
  assert.ok(r.reasons.some((x) => /blacklist/i.test(x)));
});

test('validateRadarListing: RK keywords bez majitele → SUSPECTED_BROKER', () => {
  const r = validateRadarListing({
    source: 'bazos',
    title: 'Exkluzivně zastoupení, provize, ID zakázky 99',
    description: 'Naše kancelář nabízí byt.',
  });
  assert.equal(r.status, RADAR_STATUS.SUSPECTED_BROKER);
});

test('validateRadarListing: přímý majitel → NEW_PRIVATE', () => {
  const r = validateRadarListing({
    source: 'bazos',
    title: 'Prodám 2+kk Poruba, přímý majitel, RK nevolat, bez provize',
    locality: 'Ostrava, Poruba',
    phone: '608123123',
  });
  assert.equal(r.status, RADAR_STATUS.NEW_PRIVATE);
});

test('validateRadarListing: pHash → DUPLICATE_RK', () => {
  const r = validateRadarListing(
    {
      source: 'bazos',
      title: 'Byt 2+kk',
      photoPHash: 'aaaaaaaaaaaaaaaa',
    },
    {
      referenceListings: [
        {
          listingId: 'rk-ph',
          url: 'https://www.sreality.cz/detail/rk-ph',
          photoPHash: 'aaaaaaaaaaaaaaab',
        },
      ],
    },
  );
  assert.equal(r.status, RADAR_STATUS.DUPLICATE_RK);
  assert.equal(r.matchedAgencyListingId, 'rk-ph');
  assert.ok(r.matchConfidence >= 0.85);
});

test('validateRadarListing: geo match → DUPLICATE_RK', () => {
  const r = validateRadarListing(
    {
      source: 'bezrealitky',
      title: '2+kk',
      layout: '2+kk',
      floorArea: 50,
      price: 2_500_000,
      lat: 49.83,
      lon: 18.28,
    },
    {
      referenceListings: [
        {
          listingId: 'sreality-geo',
          url: 'https://www.sreality.cz/detail/geo',
          layout: '2+kk',
          floorArea: 52,
          price: 2_600_000,
          lat: 49.8305,
          lon: 18.2805,
        },
      ],
    },
  );
  assert.equal(r.status, RADAR_STATUS.DUPLICATE_RK);
  assert.equal(r.matchedAgencyListingId, 'sreality-geo');
});

test('ingestRadarListing oddělí private stream a doplní status', () => {
  const { listing, stream, privateRow } = ingestRadarListing({
    source: 'bazos',
    title: 'Přímý majitel 3+1 Frýdek, bez provize',
    url: 'https://reality.bazos.cz/inzerat/99/?utm_source=x',
    price: '1 800 000 Kč',
    description: '71 m², tel 777 888 999',
    locality: 'Frýdek-Místek',
  }, { blacklist: [] });
  assert.equal(stream, 'private');
  assert.equal(listing.phoneE164, '+420777888999');
  assert.equal(listing.floorArea, 71);
  assert.ok(listing.sourceUrl.includes('bazos.cz'));
  assert.ok(!listing.sourceUrl.includes('utm_'));
  assert.equal(privateRow.status, listing.radarStatus);
  assert.ok(
    listing.radarStatus === RADAR_STATUS.NEW_PRIVATE || listing.radarStatus === RADAR_STATUS.SUSPECTED_BROKER,
  );
});
