import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendPriceHistory,
  buildRadarContentHash,
  detectPrivateSeller,
} from '../src/lib/radarContentHash.js';
import { listingMatchesAlert } from '../src/services/radarAlertMatch.js';

describe('radar content hash', () => {
  it('stejná lokalita+plocha+cena+dispozice → stejný hash', () => {
    const a = buildRadarContentHash({
      locality: 'Ostrava-Poruba',
      floorArea: 62,
      price: 3_250_000,
      layout: '2+kk',
    });
    const b = buildRadarContentHash({
      locality: 'Ostrava Poruba',
      floor_area: 62,
      price: 3_249_500,
      layout: '2+KK',
    });
    assert.ok(a);
    assert.equal(a, b);
  });

  it('appendPriceHistory detekuje slevu', () => {
    const { history, dropped } = appendPriceHistory(4_000_000, 3_500_000, []);
    assert.equal(dropped, 500_000);
    assert.equal(history.at(-1).delta, -500_000);
  });

  it('detectPrivateSeller z klíčových slov', () => {
    assert.equal(
      detectPrivateSeller({
        title: 'Prodej bytu',
        description: 'Přímý majitel, RK nevolat',
        source: 'sreality',
      }),
      true,
    );
    assert.equal(
      detectPrivateSeller({
        title: 'Prodej',
        description: 'Exkluzivní zastoupení realitní kanceláře',
        isAgencyListing: true,
      }),
      false,
    );
  });
});

describe('radar alert match', () => {
  it('matchuje private + district + price band', () => {
    const alert = {
      is_active: true,
      deal_types: ['sale'],
      property_types: ['flat'],
      min_price: 2_000_000,
      max_price: 4_000_000,
      districts: ['Poruba'],
      private_seller_only: true,
      price_drop_priority: true,
    };
    const hit = listingMatchesAlert(
      {
        deal_type: 'sale',
        property_type: 'flat',
        price: 3_200_000,
        locality: 'Ostrava, Poruba',
        is_private_seller: true,
        last_price_drop: 250_000,
      },
      alert,
    );
    assert.equal(hit.ok, true);
    assert.equal(hit.priority, true);
  });

  it('odmítne mimo district', () => {
    const hit = listingMatchesAlert(
      {
        deal_type: 'sale',
        property_type: 'flat',
        price: 3_000_000,
        locality: 'Brno-střed',
        is_private_seller: true,
      },
      {
        is_active: true,
        deal_types: ['sale'],
        property_types: ['flat'],
        districts: ['Poruba'],
        private_seller_only: false,
      },
    );
    assert.equal(hit.ok, false);
  });
});
