/**
 * Z textu makléře vytáhne dotaz pro GeoPas (adresa, číslo popisné, parcela, KÚ).
 */

import { isRadarMarketQuery, hasSpecificPropertyAddress } from './chatIntent.js';
import { looksLikeLocalityInfoQuery } from './localityInfoQuery.js';
import {
  isGeneralExpertQuery,
  looksLikeGarbagePropertyQuery,
  mentionsBuildingAgeNotAddress,
  mentionsDispositionNotAddress,
} from './generalExpertQuery.js';

const PARCEL_NUM_RE = /\b(\d{1,6})\s*\/\s*(\d{1,4})\b/;
const KU_RE = /(?:k\.?\s*ú\.?|katastr(?:ální)?\s+území|v\s+k\.?\s*ú\.?)\s+([A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž][\w\s\-]*)/iu;
const PROPERTY_KW =
  /\b(analyz|katastr|geopas|parcel|lv\b|záplav|hluk|vlastník|radon|k\.?\s*ú\.?|katastrální|prodejní\s+cena|odhad\s+ceny|č\.?\s*p\.?|popisné)\b/iu;

const WORD = '[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž0-9\\-]';

/** Obec/ulice + číslo popisné (ne parcela typu 2201/1). */
const CP_STREET_RE = new RegExp(`\\b(${WORD}+(?:\\s+${WORD}+)*?)\\s+(\\d{1,4})\\b`, 'u');
const CP_REV_RE = new RegExp(`\\b(\\d{1,4})\\s+(${WORD}+(?:\\s+${WORD}+)*)\\b`, 'u');

const COMMAND_PATTERNS = [
  /(?:analyz(?:uj|ovat)?(?:\s+mi)?|katastr(?:em)?|geopas)\s+(?:nemovitost\s+)?(.{2,120}?)(?:[.?!]|$)/iu,
  /nemovitost\s+(?:na\s+(?:adrese\s+)?)?(.{2,120}?)(?:[.?!]|$)/iu,
  /(?:adresa|parcela)\s+(?:č\.?\s*p\.?\s*)?(.{2,120}?)(?:[.?!]|$)/iu,
  /(?:záplav\w*|radon|hluk|lv|vlastník)\s+(?:u|na|pro|k)\s+(.{2,120}?)(?:[.?!]|$)/iu,
  /(?:zjisti|ověř|ukaž|najdi)\s+(?:lv\s+)?(?:pro\s+)?(?:parcelu?\s+)?(.{2,120}?)(?:[.?!]|$)/iu,
];

const JUNK_LEAD =
  /^(?:j[sš]ou|je|jaký\s+je|jaká\s+je|zjisti|ověř|zkontroluj|ukaž|najdi|podívej\s+se\s+na|co\s+(?:je|víš)\s+(?:o|u)|informace\s+o)\s+/iu;

const JUNK_TOPIC =
  /^(?:záplav\w*|radon|hluk|lv|list\s+vlastnictví|vlastník|katastr|okolí)\s+(?:u|na|pro|k)\s+/iu;

/** Časté 4./6. pády ulic → 1. pád (GeoPas hledá nominativ). */
export function czechStreetToNominative(text) {
  return String(text || '')
    .replace(/\b([A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]+?)ovu\b/gu, '$1ova')
    .replace(/\b([A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]+?)skou\b/gu, '$1ská')
    .replace(/\b([A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]+?)nou\b/gu, '$1ná')
    .replace(/\b([A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]+?)ovou\b/gu, '$1ová')
    .replace(/\b([A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]+?)ově\b/gu, '$1ova');
}

/** Odstraní šum z vytěžené adresy (např. „nemovitost lískovec 537“ → „lískovec 537“). */
export function normalizePropertyQuery(raw) {
  let q = String(raw || '').trim();
  q = q.replace(/\b(?:č\.?\s*p\.?|číslo\s+popisné|popisné\s+číslo|ev\.?\s*č\.?)\s*/giu, '');
  q = q.replace(JUNK_LEAD, '');
  q = q.replace(JUNK_TOPIC, '');
  q = q.replace(/^(?:nemovitost|parcelu?|adresu|objekt|dům|domu|na\s+u(?:lici|lici)?)\s+/iu, '');
  q = q.replace(/\s{2,}/g, ' ').trim();
  q = czechStreetToNominative(q);
  // Alias KÚ / obce (makléřský zápis → GeoPas název)
  q = q.replace(/\bSedliště\s+u\s+Frýdku(?:-Místku)?\b/giu, 'Sedliště ve Slezsku');
  q = q.replace(/\bMorávka\s+u\s+Frýdlantu(?:\s+nad\s+Ostravicí)?\b/giu, 'Morávka');
  // „Nádražní 1 Ostrava“ → „Nádražní 1, Ostrava“ (ne u parcel 2201/1)
  if (!q.includes(',') && !/\d\s*\/\s*\d/.test(q) && /\d{1,4}\s+[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]{3,}/u.test(q)) {
    q = q.replace(
      /(\d{1,4})\s+([A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž][\w\-]*(?:\s+[\w\-]+)?)\s*$/u,
      '$1, $2',
    );
  }
  return q.trim();
}

function stripJunkBeforeCp(text) {
  let t = String(text || '').trim();
  t = t.replace(JUNK_LEAD, '');
  t = t.replace(JUNK_TOPIC, '');
  t = t.replace(/^(?:u|na|pro|k)\s+/iu, '');
  return t.trim();
}

function isValidCpMatch(place, num, fullText) {
  const p = String(place || '').trim();
  const n = String(num || '').trim();
  if (!p || !n) return false;
  if (p.length > 40 || p.split(/\s+/).length > 5) return false;
  if (
    /\b(jak|pozn[aá]m|poznat|vlhkost|vzlínající|zjisti|co\s+víš|informace|analyz|proč|můžu|domu\s+z|kolik|stoj[ií]|cena|daň|letech)\b/iu.test(
      p,
    )
  ) {
    return false;
  }
  if (mentionsDispositionNotAddress(fullText)) return false;
  if (new RegExp(`\\b${n}\\s*\\.?\\s*let\\b`, 'iu').test(fullText)) return false;
  if (new RegExp(`\\b${n}\\s*\\+\\s*kk\\b`, 'iu').test(fullText)) return false;
  if (/\bpo\s+\d{1,2}\s*\.?\s*lete(?:ch|ch)\b/iu.test(fullText)) return false;
  if (mentionsBuildingAgeNotAddress(fullText)) return false;
  return true;
}

function extractCpFromText(text) {
  const m = stripJunkBeforeCp(text);
  if (!m || PARCEL_NUM_RE.test(m)) return null;
  if (isGeneralExpertQuery(m)) return null;

  const street = m.match(CP_STREET_RE);
  if (street) {
    let place = street[1].trim();
    const num = street[2];
    if (!isValidCpMatch(place, num, text)) return null;
    // Odmítni match přes celou větu („Jsou záplavy u Nádražní“)
    if (/\b(jsou|jaký|záplav|radon|hluk|analyz|zjisti)\b/iu.test(place)) {
      place = place.split(/\s+/).filter((w) => !/\b(jsou|je|jaký|záplav\w*|radon|hluk|u|na)\b/iu.test(w)).join(' ');
    }
    const after = m.slice(street.index + street[0].length).trim();
    const cityComma = m.includes(',') ? m.slice(m.indexOf(',') + 1).trim().split(/[.;?]/)[0] : '';
    const cityTail = !cityComma && after && /^[A-Za-zÁ-ž]/.test(after) ? after.split(/[,.;?]/)[0].trim() : '';
    const city = cityComma || cityTail;
    if (city && city.length >= 3 && city.length < 40) {
      return normalizePropertyQuery(`${place} ${num}, ${city}`);
    }
    return normalizePropertyQuery(`${place} ${num}`);
  }

  const rev = m.match(CP_REV_RE);
  if (rev) {
    if (!isValidCpMatch(rev[2], rev[1], text)) return null;
    return normalizePropertyQuery(`${rev[2]} ${rev[1]}`);
  }

  return null;
}

export function looksLikePropertyQuestion(message) {
  const m = String(message || '').trim();
  if (!m) return false;
  if (isGeneralExpertQuery(m)) return false;
  if (looksLikeLocalityInfoQuery(m)) return false;
  if (isRadarMarketQuery(m)) return false;
  if (PARCEL_NUM_RE.test(m)) return true;
  const cp = extractCpFromText(m);
  if (cp && !looksLikeGarbagePropertyQuery(cp)) return true;
  if (/\bnemovitost/i.test(m) && !hasSpecificPropertyAddress(m) && !PROPERTY_KW.test(m)) {
    return false;
  }
  return PROPERTY_KW.test(m);
}

/**
 * @returns {string|null} dotaz pro GeoPas entityByTerm
 */
export function extractPropertyQuery(message) {
  const m = String(message || '').trim();
  if (!m) return null;
  if (isGeneralExpertQuery(m)) return null;
  if (looksLikeLocalityInfoQuery(m)) return null;

  const parcel = m.match(PARCEL_NUM_RE);
  if (parcel) {
    const num = `${parcel[1]}/${parcel[2]}`;
    const ku = m.match(KU_RE);
    if (ku?.[1]) return normalizePropertyQuery(`${num} ${ku[1].trim()}`);
    const afterParcel = m.slice(m.indexOf(parcel[0]) + parcel[0].length).trim();
    const place = afterParcel
      .replace(/^[,.:;\-–]+/, '')
      .replace(/^(?:v\s+)?(?:k\.?\s*ú\.?|obci|městě)\s+/iu, '')
      .split(/[,.;?]/)[0]
      ?.trim();
    if (place && place.length >= 3 && place.length < 80) return normalizePropertyQuery(`${num} ${place}`);
    return num;
  }

  const quoted = m.match(/[„"]([^„"]{5,120})[„"]/);
  if (quoted?.[1]) return normalizePropertyQuery(quoted[1]);

  for (const re of COMMAND_PATTERNS) {
    const hit = m.match(re);
    if (hit?.[1]) {
      const normalized = normalizePropertyQuery(hit[1]);
      if (normalized.length >= 3 && !looksLikeGarbagePropertyQuery(normalized)) return normalized;
    }
  }

  if (PROPERTY_KW.test(m)) {
    const cp = extractCpFromText(m);
    if (cp && !looksLikeGarbagePropertyQuery(cp)) return cp;

    if (/\d/.test(m) && /(ul\.?|třída|náměstí|nám\.|č\.|praha|brno|ostrava)/iu.test(m)) {
      return normalizePropertyQuery(
        m.replace(/^(co\s+víš\s+o|informace\s+o|analyzuj)\s+/iu, ''),
      );
    }
  }

  const cp = extractCpFromText(m);
  if (cp && !looksLikeGarbagePropertyQuery(cp)) return cp;
  return null;
}

export function resolvePropertyQuery(message, aiParsed = {}) {
  if (looksLikeLocalityInfoQuery(message)) return null;

  const fromAi = aiParsed.propertyQuery?.trim();
  if (fromAi && fromAi.length >= 3 && !looksLikeLocalityInfoQuery(fromAi) && !/info\s+o/i.test(fromAi)) {
    if (!looksLikeGarbagePropertyQuery(fromAi)) {
      return normalizePropertyQuery(fromAi);
    }
  }

  const extracted = extractPropertyQuery(message);
  if (extracted) return extracted;

  const sell = aiParsed.updateFields?.address_property_sell?.trim();
  if (sell && looksLikePropertyQuestion(message)) return normalizePropertyQuery(sell);

  const buy = aiParsed.updateFields?.address_property_buy?.trim();
  if (buy && looksLikePropertyQuestion(message)) return normalizePropertyQuery(buy);

  if (aiParsed.intent === 'property_analysis' && fromAi && !looksLikeLocalityInfoQuery(fromAi) && !/info\s+o/i.test(fromAi)) {
    return normalizePropertyQuery(fromAi);
  }

  return null;
}

/** GeoPas jen u konkrétní adresy, parcely nebo explicitního katastru — ne u „info o lokalitě“. */
export function hasConcretePropertyTarget(message, parsed = {}) {
  const m = String(message || '').trim();
  if (!m || looksLikeLocalityInfoQuery(m)) return false;
  if (isGeneralExpertQuery(m)) return false;

  if (hasSpecificPropertyAddress(m) || PARCEL_NUM_RE.test(m)) return true;

  const fromAi = parsed.propertyQuery?.trim();
  if (parsed.intent === 'property_analysis' && fromAi) {
    if (looksLikeLocalityInfoQuery(fromAi) || /info\s+o/i.test(fromAi)) return false;
    if (hasSpecificPropertyAddress(fromAi) || PARCEL_NUM_RE.test(fromAi)) return true;
    if (/\d/.test(fromAi) && looksLikePropertyQuestion(m)) return true;
  }

  if (!looksLikePropertyQuestion(m)) return false;

  const extracted = extractPropertyQuery(m);
  if (!extracted || looksLikeGarbagePropertyQuery(extracted)) return false;
  if (/info\s+o/i.test(extracted)) return false;
  if (hasSpecificPropertyAddress(extracted) || PARCEL_NUM_RE.test(extracted)) return true;
  return /\d/.test(extracted);
}
