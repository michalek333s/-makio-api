/**
 * Dotaz na LOKALITU (obec, charakter místa) — ne katastr konkrétní parcely.
 */

import { hasSpecificPropertyAddress } from './chatIntent.js';

const LOCALITY_INFO_RE =
  /\b(?:info(?:rmace)?\s+o\s+(?:lokalit|obci|vesnic|míst)|co\s+(?:v[ií]š|zn[aá]š|je)\s+o\s+(?:lokalit|obci|vesnic|míst)|pov[eě]z\s+(?:mi\s+)?o\s+(?:lokalit|obci|vesnic)|jak[aá]\s+(?:je\s+)?(?:lokalit[aě]?|obec[i]?|vesnic[i]?|m[ií]st[aě]?|charakter)|charakter\s+(?:lokalit|obce|m[ií]sta)|o\s+lokalit[eě]|o\s+obci|jak\s+to\s+(?:je\s+)?(?:v|ve)|jak\s+(?:je\s+)?to\s+(?:v|ve)|analyzuj\s+lokalit|je\s+bezpečn\w*\s+lokalit|srovnej\s+lokalit|lepší\s+bydlet)\b/iu;

const PROPERTY_EXPLICIT =
  /\b(?:parcela|parcely|\blv\b|katastr(?:em)?|analyzuj\s+(?:nemovitost|adresu|parcelu)|vým[eě]ra\s+parce|\d{1,6}\s*\/\s*\d{1,4})\b/iu;

/** Produkt / koncept Makio — ne obec. */
const NOT_PLACE_CONCEPT_RE =
  /\b(?:safety\s*score|skóre\s+bezpečnost|yield|ltv|dsti|gross|net\s+yield|homestaging|geopas|makio|crm)\b/iu;

/**
 * Makléř se ptá na obec/lokalitu — ne na konkrétní nemovitost v katastru.
 */
export function looksLikeLocalityInfoQuery(message) {
  const m = String(message || '').trim();
  if (!m) return false;
  if (hasSpecificPropertyAddress(m)) return false;
  if (PROPERTY_EXPLICIT.test(m)) return false;
  if (NOT_PLACE_CONCEPT_RE.test(m)) return false;

  if (LOCALITY_INFO_RE.test(m)) return true;

  // „info Lískovec“ / „info o Lískovci“ bez slova lokalita
  if (/^\s*info(?:rmace)?\s+(?:o\s+)?[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]{3,}/iu.test(m)) {
    if (!/\b(?:score|yield|ltv|smlouv|klient)\b/iu.test(m)) return true;
  }

  if (
    /\b(?:lokalit\w*|obec\w*|vesnic\w*|m[ií]st\w*|čtvrť|ctvrt)\b/iu.test(m) &&
    /\b(?:zjisti|info|co\s+víš|co\s+vis|jaká|jaka|jaký|jaky|charakter|vhodn|klid|hluk|bezpečn|analyzuj|srovnej|lepší)\b/iu.test(
      m,
    )
  ) {
    return true;
  }

  // „jak to je ve Frýdku-Místku?“ / „jak to je v Řepišti?“
  if (/^\s*jak\s+to\s+(?:je\s+)?(?:v|ve)\s+/iu.test(m)) return true;
  if (/^\s*jak\s+(?:je\s+)?to\s+(?:v|ve)\s+/iu.test(m)) return true;

  // Srovnání dvou obcí
  if (
    /\b(?:lepší\s+bydlet|srovnej|porovnej)\b/iu.test(m) &&
    /\b(?:nebo|vs\.?|versus)\b/iu.test(m) &&
    !/\b(?:porotherm|ytong|heluz|byt|dum|pozemek)\b/iu.test(m)
  ) {
    return true;
  }

  return false;
}

/**
 * @returns {string|null}
 */
export function extractLocalityNameFromMessage(message) {
  const m = String(message || '').trim();
  const patterns = [
    /(?:info(?:rmace)?\s+o\s+lokalit[eě]\s+)(.+?)$/iu,
    /(?:analyzuj\s+lokalit[eu]\s+)(.+?)$/iu,
    /(?:je\s+bezpečn[aáýéí]\w*\s+lokalit[aěyu]?\s+)(.+?)$/iu,
    /(?:co\s+(?:v[ií]š|zn[aá]š|je)\s+o\s+(?:lokalit[eě]\s+)?)(.+?)$/iu,
    /(?:o\s+lokalit[eě]\s+)(.+?)$/iu,
    /(?:o\s+obci\s+)(.+?)$/iu,
    /(?:jak[aá]\s+(?:je\s+)?(?:lokalit|obec|vesnic)[aě]?\s+)(.+?)$/iu,
    /(?:pov[eě]z\s+(?:mi\s+)?o\s+(?:obci\s+|lokalit[eě]\s+)?)(.+?)$/iu,
    /(?:jak\s+to\s+(?:je\s+)?(?:v|ve)\s+)(.+?)$/iu,
    /(?:jak\s+(?:je\s+)?to\s+(?:v|ve)\s+)(.+?)$/iu,
    /(?:info(?:rmace)?\s+(?:o\s+)?)(.+?)$/iu,
    /(?:lepší\s+bydlet\s*[—–-]?\s*)(.+?)$/iu,
  ];

  for (const re of patterns) {
    const hit = m.match(re);
    if (hit?.[1]) {
      let name = hit[1].replace(/[?.!]+$/, '').trim();
      name = name.replace(/^(?:lokalit[eě]\s+)/iu, '');
      name = name.replace(/\s+nebo\s+.+$/iu, '').trim();
      if (name.length >= 3 && name.length < 80 && !NOT_PLACE_CONCEPT_RE.test(name)) return name;
    }
  }

  const loose = m.match(/lokalit[eě]\s+(.+?)$/iu);
  if (loose?.[1]) {
    const name = loose[1].replace(/[?.!]+$/, '').trim();
    if (name.length >= 3 && !NOT_PLACE_CONCEPT_RE.test(name)) return name;
  }

  return null;
}
