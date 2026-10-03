/**
 * Ukázková data pro Radar — jen když je demo fallback výslovně povolen.
 * Production: default OFF (žádné tiché demo-*).
 */

import { applyAgencySignals } from '../services/listingAgency.js';

const SAMPLES = [
  {
    listingId: 'demo-ostrava-1',
    source: 'bezrealitky',
    title: 'Prodej bytu 2+kk, Ostrava-Poruba',
    price: 2_890_000,
    pricePerSqm: 62_800,
    locality: 'Ostrava, Poruba',
    layout: '2+kk',
    floorArea: 46,
    isAgencyListing: false,
    fsboSignal: true,
    daysOnPortal: 12,
    imageUrl: null,
    description: 'Přímý majitel, bez provize, RK nevolat. Volat 605 111 222.',
    phone: '605111222',
  },
  {
    listingId: 'demo-ostrava-2',
    source: 'sreality',
    title: 'Prodej bytu 3+1, Ostrava-Vítkovice — prodám sám',
    price: 3_450_000,
    pricePerSqm: 48_600,
    locality: 'Ostrava, Vítkovice',
    layout: '3+1',
    floorArea: 71,
    sellerType: 'private',
    fsboSignal: true,
    daysOnPortal: 28,
  },
  {
    listingId: 'demo-fm-1',
    source: 'sreality',
    title: 'Prodej bytu 2+1, Frýdek-Místek — bez RK',
    price: 2_650_000,
    pricePerSqm: 55_200,
    locality: 'Frýdek-Místek',
    layout: '2+1',
    floorArea: 48,
    sellerType: 'private',
    fsboSignal: true,
    daysOnPortal: 7,
  },
  {
    listingId: 'demo-ostrava-3',
    source: 'sreality',
    title: 'Prodej bytu 1+kk, Ostrava-Hrabůvka',
    price: 1_990_000,
    pricePerSqm: 71_000,
    locality: 'Ostrava, Hrabůvka',
    layout: '1+kk',
    floorArea: 28,
    isAgencyListing: true,
    agencyName: 'RE/MAX G8 Reality',
    sellerType: 'agency',
    daysOnPortal: 45,
    lat: 49.791,
    lng: 18.27,
    photoPHash: 'a1b2c3d4e5f60708',
    url: 'https://www.sreality.cz/detail/prodej/byt/1+kk/ostrava/demo-rk-hrabuvka',
  },
  {
    listingId: 'demo-ostrava-4',
    source: 'sreality',
    title: 'Prodej bytu 4+kk, Ostrava-Mariánské Hory',
    price: 4_200_000,
    pricePerSqm: 52_500,
    locality: 'Ostrava, Mariánské Hory',
    layout: '4+kk',
    floorArea: 80,
    isAgencyListing: true,
    agencyName: 'Century 21',
    daysOnPortal: 120,
  },
  {
    listingId: 'demo-karvina-1',
    source: 'bazos',
    title: 'Prodej bytu 2+kk Karviná',
    price: 1_750_000,
    pricePerSqm: 43_750,
    locality: 'Karviná',
    layout: '2+kk',
    floorArea: 40,
    isAgencyListing: false,
    fsboSignal: true,
    daysOnPortal: 5,
    description: 'Prodávám sám, přímý majitel. Tel 777 444 333.',
    phone: '777444333',
  },
  {
    listingId: 'demo-bazos-dup-1',
    source: 'bazos',
    title: 'Byt 1+kk Ostrava-Hrabůvka — prodám',
    price: 2_050_000,
    pricePerSqm: 68_300,
    locality: 'Ostrava, Hrabůvka',
    layout: '1+kk',
    floorArea: 30,
    isAgencyListing: false,
    fsboSignal: true,
    daysOnPortal: 4,
    lat: 49.7912,
    lng: 18.2702,
    photoPHash: 'a1b2c3d4e5f60708',
    description: 'Hezký byt, volejte 608 200 100.',
    phone: '608200100',
  },
  {
    listingId: 'demo-bazos-rk-1',
    source: 'bazos',
    title: 'Prodej 2+kk Ostrava — zastoupení majitele',
    price: 2_990_000,
    locality: 'Ostrava, Jih',
    layout: '2+kk',
    floorArea: 52,
    isAgencyListing: false,
    daysOnPortal: 9,
    description:
      'Exkluzivně nabízíme zastoupení. ID zakázky 4412, naše kancelář, provize smluvní. RK.',
    phone: '596111000',
  },
  {
    listingId: 'demo-fb-ostrava-1',
    source: 'facebook',
    title: 'Prodám byt 2+kk Ostrava-Poruba — Facebook',
    price: 2_750_000,
    pricePerSqm: 59_800,
    locality: 'Ostrava, Poruba',
    layout: '2+kk',
    floorArea: 46,
    fsboSignal: true,
    sellerType: 'private',
    daysOnPortal: 3,
  },
];

/** true jen když smíme vracet ukázková data (nikdy tiše — v production vždy OFF). */
export function isRadarDemoFallbackEnabled() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return false;
  const v = String(process.env.RADAR_DEMO_FALLBACK || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function isDemoListing(listing) {
  if (!listing) return false;
  const id = String(listing.listingId || listing.id || '');
  if (id.startsWith('demo-')) return true;
  if (listing.source === 'demo') return true;
  return false;
}

export function stripDemoListings(listings) {
  if (!Array.isArray(listings)) return [];
  return listings.filter((l) => !isDemoListing(l));
}

/** Ukázkové inzeráty jsou geograficky MSK (Ostrava / FM / Karviná) — nikdy je neoznačuj jako jiný kraj. */
export const DEMO_RADAR_REGION = 'Moravskoslezský';

function sameRadarRegion(a, b) {
  const norm = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .trim();
  return norm(a) === norm(b);
}

/**
 * Demo fallback jen pro Moravskoslezský.
 * Pro Praha/Brno/… vrať [] → scan nastaví cacheEmpty (žádné lži o trhu).
 */
export function getDemoRadarListings(region = DEMO_RADAR_REGION) {
  if (!isRadarDemoFallbackEnabled()) return [];
  const requested = String(region || DEMO_RADAR_REGION).trim() || DEMO_RADAR_REGION;
  if (!sameRadarRegion(requested, DEMO_RADAR_REGION)) {
    return [];
  }

  return SAMPLES.map((row) =>
    applyAgencySignals({
      ...row,
      region: DEMO_RADAR_REGION,
      scrapedAt: new Date().toISOString(),
      foundOnPortals: [row.source],
    }),
  );
}

export const DEMO_RADAR_WARNING =
  'Ukázková data (Moravskoslezský) — Apify/Sreality nejsou dostupné. Nejsou to živé nabídky trhu. Pro živý Radar navýšte Apify nebo spusťte „Obnovit cache“.';
