import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRadarUuid,
  sanitizePrivateRow,
  sanitizeReferenceRow,
  slimRadarPayload,
} from '../src/services/radarV2Store.js';
import { listingsToIngestShape } from '../src/services/radarIngest.js';
import { attachRadarValidation, RADAR_STATUS } from '../src/services/radarValidate.js';

test('isRadarUuid', () => {
  assert.equal(isRadarUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isRadarUuid('sreality-123'), false);
  assert.equal(isRadarUuid(null), false);
});

test('sanitizePrivateRow: bez URL nebo statusu se neuloží', () => {
  assert.equal(sanitizePrivateRow({ source: 'bazos', status: 'NEW_PRIVATE' }), null);
  assert.equal(
    sanitizePrivateRow({
      source: 'bazos',
      source_url: 'https://reality.bazos.cz/inzerat/1',
      status: null,
    }),
    null,
  );
});

test('sanitizePrivateRow: matched_agency_listing_id jen UUID', () => {
  const row = sanitizePrivateRow({
    source: 'bazos',
    source_url: 'https://reality.bazos.cz/inzerat/1?utm_source=x',
    status: 'DUPLICATE_RK',
    matched_agency_listing_id: 'sreality-9',
    matched_agency_url: 'https://www.sreality.cz/detail/1',
    payload: { _raw: { huge: true }, title: 'x' },
  });
  assert.equal(row.matched_agency_listing_id, null);
  assert.equal(row.source_url, 'https://reality.bazos.cz/inzerat/1');
  assert.equal(row.payload._raw, undefined);
  assert.equal(row.status, 'DUPLICATE_RK');
});

test('sanitizeReferenceRow vyžaduje URL', () => {
  assert.equal(sanitizeReferenceRow({ source: 'sreality', title: 'x' }), null);
  const row = sanitizeReferenceRow({
    source: 'sreality',
    source_url: 'https://www.sreality.cz/detail/abc',
    agency_name: 'RE/MAX',
  });
  assert.equal(row.agency_name, 'RE/MAX');
});

test('sanitizePrivateRow persistuje image_urls / image_hashes, status se nedeaultuje', () => {
  const row = sanitizePrivateRow({
    source: 'bazos',
    source_url: 'https://reality.bazos.cz/inzerat/img',
    status: 'NEW_PRIVATE',
    image_urls: ['https://cdn.example/a.jpg', ''],
    image_hashes: ['aaaaaaaaaaaaaaaa'],
  });
  assert.deepEqual(row.image_urls, ['https://cdn.example/a.jpg']);
  assert.deepEqual(row.image_hashes, ['aaaaaaaaaaaaaaaa']);

  assert.equal(
    sanitizePrivateRow({
      source: 'bazos',
      source_url: 'https://reality.bazos.cz/inzerat/nostatus',
      status: null,
    }),
    null,
  );
});

test('slimRadarPayload zahodí _raw', () => {
  assert.equal(slimRadarPayload({ _raw: { a: 1 }, title: 'Byt' }).title, 'Byt');
  assert.equal(slimRadarPayload({ _raw: { a: 1 }, title: 'Byt' })._raw, undefined);
});

test('listingsToIngestShape: RK → reference, soukromník se statusem → private', () => {
  const rows = listingsToIngestShape([
    {
      source: 'sreality',
      url: 'https://www.sreality.cz/detail/rk',
      isAgencyListing: true,
      agencyName: 'M&M',
      title: 'RK byt',
    },
    {
      source: 'bazos',
      url: 'https://reality.bazos.cz/inzerat/2',
      radarStatus: RADAR_STATUS.NEW_PRIVATE,
      title: 'Majitel',
      fsboSignal: true,
    },
  ]);
  assert.equal(rows[0].referenceRow.source_url.includes('sreality'), true);
  assert.equal(rows[0].privateRow, null);
  assert.equal(rows[1].privateRow.status, RADAR_STATUS.NEW_PRIVATE);
  assert.equal(rows[1].referenceRow, null);
});

test('attachRadarValidation použije extraReferences z DB', () => {
  const out = attachRadarValidation(
    [
      {
        source: 'bazos',
        title: '2+kk',
        layout: '2+kk',
        floorArea: 50,
        price: 2_500_000,
        lat: 49.83,
        lon: 18.28,
        url: 'https://reality.bazos.cz/inzerat/geo',
      },
    ],
    {
      extraReferences: [
        {
          listingId: '550e8400-e29b-41d4-a716-446655440000',
          url: 'https://www.sreality.cz/detail/geo',
          layout: '2+kk',
          floorArea: 52,
          price: 2_600_000,
          lat: 49.8305,
          lon: 18.2805,
          isAgencyListing: true,
          source: 'sreality',
        },
      ],
    },
  );
  assert.equal(out[0].radarStatus, RADAR_STATUS.DUPLICATE_RK);
  assert.equal(out[0].matchedAgencyUrl, 'https://www.sreality.cz/detail/geo');
});
