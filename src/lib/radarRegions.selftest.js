/**
 * Radar region filter + demo isolation.
 *   node src/lib/radarRegions.selftest.js
 * (spouštět z nemio-backend)
 */
import { filterListingsByRegion } from './radarRegions.js';
import { getDemoRadarListings, DEMO_RADAR_REGION } from '../data/radarDemoListings.js';

process.env.RADAR_DEMO_FALLBACK = '1';
process.env.NODE_ENV = 'development';

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

const stampedLie = [
  {
    listingId: 'demo-ostrava-1',
    title: 'Prodej bytu 2+kk, Ostrava-Poruba',
    locality: 'Ostrava, Poruba',
    region: 'Praha',
  },
];

assert(
  'filter: Ostrava stamped as Praha → dropped',
  filterListingsByRegion(stampedLie, 'Praha').length === 0,
);

assert(
  'filter: Ostrava stamped as MSK → kept',
  filterListingsByRegion([{ ...stampedLie[0], region: 'Moravskoslezský' }], 'Moravskoslezský')
    .length === 1,
);

assert(
  'filter: Praha locality in Praha → kept',
  filterListingsByRegion(
    [{ title: 'Byt Praha 5', locality: 'Praha 5', region: 'Praha' }],
    'Praha',
  ).length === 1,
);

assert(
  'filter: empty locality without stamp match → dropped',
  filterListingsByRegion(
    [{ title: 'Prodej', locality: '', region: 'Praha' }],
    'Moravskoslezský',
  ).length === 0,
);

assert(
  'filter: empty locality with stamp match → dropped (strict)',
  filterListingsByRegion(
    [{ title: 'Prodej', locality: '', region: 'Moravskoslezský' }],
    'Moravskoslezský',
  ).length === 0,
);

assert(
  'filter: Brno stamped as MSK → dropped',
  filterListingsByRegion(
    [{ title: 'Byt', locality: 'Brno-střed', region: 'Moravskoslezský' }],
    'Moravskoslezský',
  ).length === 0,
);

assert(
  'filter: Olomouc in title stamped MSK → dropped',
  filterListingsByRegion(
    [{ title: 'Prodej bytu Olomouc', locality: 'Olomouc', region: 'Moravskoslezský' }],
    'Moravskoslezský',
  ).length === 0,
);

assert(
  'filter: Bezrealitky dropped even in MSK',
  filterListingsByRegion(
    [{ title: 'Byt Ostrava', locality: 'Ostrava', source: 'bezrealitky', url: 'https://www.bezrealitky.cz/x' }],
    'Moravskoslezský',
  ).length === 0,
);

assert(
  'filter: Karviná Olšiny → kept',
  filterListingsByRegion(
    [{ title: 'Dům', locality: 'Olšiny, Karviná', region: 'Moravskoslezský' }],
    'Moravskoslezský',
  ).length === 1,
);

const demoPraha = getDemoRadarListings('Praha');
assert('demo: Praha → empty', demoPraha.length === 0, demoPraha.length);

const demoMsk = getDemoRadarListings('Moravskoslezský');
assert('demo: MSK → samples', demoMsk.length > 0);
assert(
  'demo: MSK region stamp',
  demoMsk.every((l) => l.region === DEMO_RADAR_REGION),
);

assert(
  'REGION_IDS: Moravskoslezský = 7 (Apify/logiover)',
  (await import('../services/sreality.js')).REGION_IDS.Moravskoslezský === 7,
);

console.log(failed ? `\nFAILED ${failed}` : '\nAll passed');
process.exit(failed ? 1 : 0);
