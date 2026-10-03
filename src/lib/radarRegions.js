import { dropExcludedRadarSources } from './listingFilters.js';

export const RADAR_REGIONS = [
  'Moravskoslezský',
  'Praha',
  'Jihomoravský',
  'Středočeský',
  'Ústecký',
  'Olomoucký',
  'Zlínský',
  'Plzeňský',
  'Liberecký',
  'Královéhradecký',
  'Pardubický',
  'Jihočeský',
  'Karlovarský',
  'Vysočina',
];

/** @type {Record<string, { cities: string[], fbCity: string }>} */
export const REGION_META = {
  Moravskoslezský: {
    cities: [
      'Ostrava',
      'Ostrava-město',
      'Frýdek-Místek',
      'Frýdek',
      'Místek',
      'Karviná',
      'Havířov',
      'Opava',
      'Třinec',
      'Nový Jičín',
      'Český Těšín',
      'Kopřivnice',
      'Bohumín',
      'Orlová',
      'Krnov',
      'Bruntál',
      'Frenštát',
      'Frenštát pod Radhoštěm',
      'Poruba',
      'Vítkovice',
      'Hlučín',
      'Jablunkov',
      'Třanovice',
      'Mosty u Jablunkova',
      'Návsí',
      'Bílovec',
      'Fulnek',
      'Studénka',
      'Příbor',
      'Štramberk',
      'Rýmařov',
      'Vrbno pod Pradědem',
      'Vítkov',
      'Odry',
      'Petřvald',
      'Rychvald',
      'Doubrava',
      'Horní Suchá',
      'Stonava',
      'Albrechtice',
      'Těrlicko',
      'Čeladná',
      'Ostravice',
      'Frýdlant nad Ostravicí',
      'Paskov',
      'Staříč',
      'Řepiště',
      'Vendryně',
      'Bystrice',
      'Bystřice',
      'Hnojník',
      'Třinecko',
      'Karvinsko',
      'Opavsko',
      'Ostravsko',
      'Moravskoslezský',
      'Moravskoslezsky',
      'MSK',
      'Slezská Ostrava',
      'Mariánské Hory',
      'Zábřeh',
      'Hrabůvka',
      'Výškovice',
      'Dubina',
      'Přívoz',
      'Muglinov',
      'Radvanice',
      'Bartovice',
      'Kunčice',
      'Heřmanice',
      'Třebovice',
      'Martinov',
      'Hošťálkovice',
      'Ostrava-Zábřeh',
      'Ostrava Zábřeh',
      'Polanka',
      'Stará Bělá',
      'Nová Bělá',
      'Proskovice',
      'Olšiny',
    ],
    fbCity: 'ostrava',
  },
  Praha: { cities: ['Praha', 'Prague'], fbCity: 'prague' },
  Jihomoravský: {
    cities: [
      'Brno',
      'Znojmo',
      'Břeclav',
      'Hodonín',
      'Vyškov',
      'Blansko',
      'Tišnov',
      'Židenice',
      'Líšeň',
      'Bystrc',
      'Královo Pole',
      'Bohunice',
    ],
    fbCity: 'brno',
  },
  Středočeský: {
    cities: ['Kladno', 'Mladá Boleslav', 'Kolín', 'Příbram', 'Mělník', 'Benešov'],
    fbCity: 'prague',
  },
  Ústecký: { cities: ['Ústí nad Labem', 'Teplice', 'Děčín', 'Most', 'Chomutov'], fbCity: 'usti-nad-labem' },
  Olomoucký: { cities: ['Olomouc', 'Prostějov', 'Přerov', 'Šumperk', 'Jeseník'], fbCity: 'olomouc' },
  Zlínský: { cities: ['Zlín', 'Uherské Hradiště', 'Vsetín', 'Kroměříž'], fbCity: 'zlin' },
  Plzeňský: { cities: ['Plzeň', 'Klatovy', 'Rokycany', 'Tachov'], fbCity: 'plzen' },
  Liberecký: { cities: ['Liberec', 'Jablonec nad Nisou', 'Česká Lípa'], fbCity: 'liberec' },
  Královéhradecký: { cities: ['Hradec Králové', 'Trutnov', 'Náchod', 'Jičín'], fbCity: 'hradec-kralove' },
  Pardubický: { cities: ['Pardubice', 'Chrudim', 'Svitavy', 'Ústí nad Orlicí'], fbCity: 'pardubice' },
  Jihočeský: { cities: ['České Budějovice', 'Tábor', 'Písek', 'Strakonice'], fbCity: 'ceske-budejovice' },
  Karlovarský: { cities: ['Karlovy Vary', 'Sokolov', 'Cheb'], fbCity: 'karlovy-vary' },
  Vysočina: { cities: ['Jihlava', 'Třebíč', 'Havlíčkův Brod', 'Žďár'], fbCity: 'jihlava' },
};

export function regionCities(region) {
  return REGION_META[region]?.cities || [region];
}

function normalizePlace(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Všechna „cizí“ města z ostatních krajů (pro vyloučení při chybějícím region labelu). */
function foreignCityTokens(region) {
  const own = new Set(regionCities(region).map(normalizePlace));
  const foreign = [];
  for (const [name, meta] of Object.entries(REGION_META)) {
    if (name === region) continue;
    for (const city of meta.cities || []) {
      const token = normalizePlace(city);
      if (token && !own.has(token)) foreign.push(token);
    }
  }
  return foreign;
}

function haystack(listing) {
  return normalizePlace(
    [
      listing.locality,
      listing.city,
      listing.address,
      listing.district,
      listing.title,
      listing.url,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

function locationHaystack(listing) {
  return normalizePlace(
    [listing.locality, listing.city, listing.address, listing.district, listing.url]
      .filter(Boolean)
      .join(' '),
  );
}

function hasToken(hay, token) {
  if (!hay || !token) return false;
  if (token.length <= 3) {
    return ` ${hay} `.includes(` ${token} `);
  }
  return hay.includes(token);
}

/**
 * Ponechá jen inzeráty, které patří do kraje.
 * Razítko `region` z cache/Apify NESTAČÍ — musí sedět město/okres v lokalitě, URL nebo titulku.
 */
export function listingBelongsToRegion(listing, region) {
  if (!listing || typeof listing !== 'object' || !region) return false;

  const cities = regionCities(region)
    .map(normalizePlace)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const foreign = foreignCityTokens(region).sort((a, b) => b.length - a.length);
  const regionNorm = normalizePlace(region);
  const locHay = locationHaystack(listing);
  const fullHay = haystack(listing);

  const inOwn = (hay) => cities.some((c) => hasToken(hay, c)) || hasToken(hay, regionNorm);
  const inForeign = (hay) =>
    foreign.some((c) => {
      if (c === 'most' && hasToken(hay, 'mosty u jablunkova')) return false;
      return hasToken(hay, c);
    });

  if (locHay && inForeign(locHay) && !inOwn(locHay) && !inOwn(fullHay)) return false;
  if (inOwn(locHay) || inOwn(fullHay)) return true;
  return false;
}

/**
 * Ponechá jen inzeráty patřící do kraje (ochrana proti mísení cache / Apify / špatnému stampu).
 * @param {object[]} listings
 * @param {string} region
 */
export function filterListingsByRegion(listings, region) {
  if (!Array.isArray(listings) || !region) return dropExcludedRadarSources(listings || []);
  return dropExcludedRadarSources(
    listings.filter((listing) => listingBelongsToRegion(listing, region)),
  );
}

export function facebookMarketplaceUrls(region, propertyType = 'byty') {
  const fbCity = REGION_META[region]?.fbCity;
  if (!fbCity) return [];

  const category =
    propertyType === 'pozemky'
      ? 'propertyforsale'
      : 'propertyforsale';

  return [
    `https://www.facebook.com/marketplace/${fbCity}/search?query=${encodeURIComponent(
      propertyType === 'byty' ? 'byt' : propertyType === 'domy' ? 'dům' : 'pozemek',
    )}`,
    `https://www.facebook.com/marketplace/${fbCity}/${category}`,
  ];
}
