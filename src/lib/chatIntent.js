/**
 * Rozlišení: GeoPas (konkrétní adresa/parcela) vs. Radar (trh / město / investice).
 * Matching běží na ASCII verzi textu — funguje i bez diakritiky (prover, investicni).
 */

import { REGION_IDS } from '../services/sreality.js';
import { looksLikeLocalityInfoQuery } from './localityInfoQuery.js';
import { isContextualMarketQuery } from './chatContextLocality.js';
import {
  isGeneralExpertQuery,
  mentionsBuildingAgeNotAddress,
  mentionsDispositionNotAddress,
} from './generalExpertQuery.js';

const PARCEL_NUM_RE = /\b(\d{1,6})\s*\/\s*(\d{1,4})\b/;

/** Odstraní diakritiku pro tolerantní matching. */
export function foldCzechText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Explicitní trh / portály — ne obecné „porovnej“ nebo „investiční“ bez místa. */
const RADAR_EXPLICIT_ASCII =
  /(radar|na trhu|soukromnik|fsbo|bezrealitky|bazos|sreality|naber|prilezitost|potencial)/i;

const RADAR_LISTING_COMPARE_ASCII =
  /(?:porovnej|srovnej|srovnani)\s+(?:nabidk|inzerat|byty|domy|pozemky|ceny)/i;

const INVEST_WITH_PLACE_ASCII = /investic/;

const CITY_WIDE_ASCII = /(jako takov|obecne|cele mesto|ve meste|v obci|v oblasti)/i;

const MARKET_VERB_ASCII =
  /(prover|prověř|zkontroluj|zkontorluj|projdi|najdi|ukaz|vyhledej|scan|sken|hledej|over|overit)/i;

const GEOPAS_BLOCK_ASCII = /(katastr|\blv\b|parcel|vlastnik|geopas|zaplav|hluk)/i;

const PRICING_ADVICE_ASCII =
  /(nastav|nastaveni|nabidkov(a|ou) cen|realizacni cen|cenov(a|ou) strateg|jak cenit|jak nacenit|kolik stoji|kolik ma stat)/i;

const CITY_ALIASES = [
  { re: /frydek|frydku|mistek|mistku|\bfm\b/i, region: 'Moravskoslezský', label: 'Frýdek-Místek' },
  { re: /ostrava|ostrav/i, region: 'Moravskoslezský', label: 'Ostrava' },
  { re: /karvina|havirov|koprivnice|trinec/i, region: 'Moravskoslezský' },
  { re: /brno|jihomoravsk/i, region: 'Jihomoravský', label: 'Brno' },
  { re: /praha|praze/i, region: 'Praha', label: 'Praha' },
  { re: /olomouc/i, region: 'Olomoucký', label: 'Olomouc' },
  { re: /plzen/i, region: 'Plzeňský', label: 'Plzeň' },
  { re: /liberec/i, region: 'Liberecký', label: 'Liberec' },
  { re: /usti/i, region: 'Ústecký' },
  { re: /zlin/i, region: 'Zlínský', label: 'Zlín' },
  { re: /hradec|pardubice/i, region: 'Královéhradecký' },
  { re: /budejovice|jihocesk/i, region: 'Jihočeský' },
  { re: /kladno|stredocesk/i, region: 'Středočeský' },
];

const CP_ASCII = /\b[a-z][a-z\-]*\s+\d{1,4}\b/i;

const QUESTION_NOISE_RE =
  /\b(jak|pozn[aá]m|poznat|vlhkost|vzlin|proc|muzu|domu\s+z)\b/i;

const YEAR_CP_FALSE_RE = /\b(?:z|v|po)\s+\d{1,3}\s*\.?\s*let/i;
const PRICE_VERB_BEFORE_NUM_RE = /\b(?:stoj[ií]|stoji|stát|stat|cena|ceny|kk)\b/i;

export function hasSpecificPropertyAddress(message) {
  const raw = String(message || '').trim();
  if (!raw) return false;
  if (mentionsBuildingAgeNotAddress(raw)) return false;
  if (mentionsDispositionNotAddress(raw)) return false;
  if (PARCEL_NUM_RE.test(raw)) return true;
  const folded = foldCzechText(raw);
  if (YEAR_CP_FALSE_RE.test(folded)) return false;
  if (/\b\d{1,2}\s*\+\s*kk\b/i.test(folded)) return false;
  if (CP_ASCII.test(folded) && /\d/.test(folded)) {
    const m = folded.match(/\b([a-z]{3,}(?:[\s-][a-z]{2,}){0,3})\s+(\d{1,4})\b/i);
    if (m) {
      if (QUESTION_NOISE_RE.test(m[1])) return false;
      if (PRICE_VERB_BEFORE_NUM_RE.test(m[1])) return false;
      if (/\b(?:kolik|stoj|cena|da[nň]|letech|letech)\b/i.test(m[1])) return false;
      if (m[1].split(/\s+/).length > 4) return false;
      if (new RegExp(`\\b${m[2]}\\s*\\.?\\s*let`, 'i').test(folded)) return false;
      // „3+kk“ / číslo hned před +kk
      if (new RegExp(`\\b${m[2]}\\s*\\+\\s*kk\\b`, 'i').test(folded)) return false;
      return true;
    }
  }
  if (/(ul\.|trida|namesti|nam\.)\s+/i.test(folded) && /\d/.test(folded)) return true;
  return false;
}

export function isRadarMarketQuery(message, history = []) {
  const raw = String(message || '').trim();
  if (!raw) return false;
  if (looksLikeLocalityInfoQuery(raw)) return false;
  if (isGeneralExpertQuery(raw)) return false;
  if (hasSpecificPropertyAddress(raw)) return false;

  if (isContextualMarketQuery(raw, history)) return true;

  const m = foldCzechText(raw);

  // Cenová rada / strategie — ne sken portálů
  if (PRICING_ADVICE_ASCII.test(m) && !RADAR_EXPLICIT_ASCII.test(m)) return false;

  if (RADAR_EXPLICIT_ASCII.test(m)) return true;
  if (RADAR_LISTING_COMPARE_ASCII.test(m)) return true;

  // „investiční byty v Ostravě“ — investice + místo (ne „má smysl investiční byt?“ bez místa)
  if (INVEST_WITH_PLACE_ASCII.test(m) && mentionsPlace(m)) return true;

  if (CITY_WIDE_ASCII.test(m) && mentionsPlace(m)) return true;

  if (MARKET_VERB_ASCII.test(m) && mentionsPlace(m) && !GEOPAS_BLOCK_ASCII.test(m)) {
    return true;
  }

  // „najdi pozemky“ + název obce v téže větě
  if (MARKET_VERB_ASCII.test(m) && /(?:pozemk|byt|dom)/i.test(m) && mentionsPlace(m)) {
    return true;
  }

  return false;
}

export function mentionsPlace(foldedMessage) {
  if (CITY_ALIASES.some(({ re }) => re.test(foldedMessage))) return true;
  for (const name of Object.keys(REGION_IDS)) {
    if (foldedMessage.includes(foldCzechText(name))) return true;
  }
  return false;
}

export function resolveRegionFromChat(message, fallback = 'Moravskoslezský') {
  const m = foldCzechText(message);
  for (const { re, region } of CITY_ALIASES) {
    if (re.test(m)) return region;
  }
  for (const name of Object.keys(REGION_IDS)) {
    if (m.includes(foldCzechText(name))) return name;
  }
  return fallback;
}

export function resolvePlaceLabelFromChat(message, region) {
  const m = foldCzechText(message);
  for (const { re, label, region: r } of CITY_ALIASES) {
    if (label && re.test(m)) return label;
  }
  return region;
}

export function inferPropertyTypeFromChat(message) {
  const m = foldCzechText(message);
  if (/(dum|domy|rodinny dum)/i.test(m)) return 'domy';
  if (/(pozemek|pozemky)/i.test(m)) return 'pozemky';
  return 'byty';
}
