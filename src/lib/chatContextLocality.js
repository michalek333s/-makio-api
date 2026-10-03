/**
 * Kontext z historie chatu — „v této lokalitě“, „tady“, „tam“ → poslední zmíněná obec.
 */

import { foldCzechText } from './chatIntent.js';
import { extractLocalityNameFromMessage } from './localityInfoQuery.js';

const CONTEXTUAL_LOCALITY_RE =
  /\b(?:t[eé]to|t[eé]to\s+lokalit|t[eé]to\s+obci|tady|tam|zde|v\s+n[ií]|stejn[eé]|v\s+oblasti|v\s+tom\s+m[ií]st[eě]|v\s+tomto)\b/iu;

const MARKET_SEARCH_RE =
  /\b(?:najdi|najít|vyhledej|hledej|uk[aá]z|projdi|srovnej|porovnej|nab[ií]dk|inzer[aá]t|pozemk|byt[yů]?|dom[yů]?|nemovitost)\b/iu;

/** Makléř odkazuje na lokalitu z předchozí konverzace. */
export function referencesContextualLocality(message) {
  return CONTEXTUAL_LOCALITY_RE.test(foldCzechText(message));
}

export function looksLikeMarketSearch(message) {
  const m = foldCzechText(message);
  if (!m) return false;
  return (
    MARKET_SEARCH_RE.test(m) ||
    /(?:radar|trh|fsbo|soukromnik|investic)/i.test(m)
  );
}

/**
 * @param {Array<{ role?: string, text?: string, parsedData?: object }>} history
 * @returns {string|null}
 */
export function resolveLocalityFromChatHistory(history = []) {
  const items = Array.isArray(history) ? history.slice(-14).reverse() : [];

  for (const msg of items) {
    const text = String(msg?.text || '').trim();
    if (!text || text === 'intro') continue;

    const parsed = msg?.parsedData || msg?.parsed_data;
    if (parsed?.municipalityName) {
      return String(parsed.municipalityName).trim();
    }

    if (msg.role === 'user' || msg.role === 'Makléř') {
      const fromUser = extractLocalityNameFromMessage(text);
      if (fromUser) return fromUser;
    }

    const mrkneme = text.match(/\bmrkneme\s+na\s+([^.!\n]+)/iu);
    if (mrkneme?.[1]) {
      const name = mrkneme[1].replace(/\*\*/g, '').trim();
      if (name.length >= 3 && name.length < 80) return name;
    }

    const boldLead = text.match(/^\*\*([^*]{3,70})\*\*/u);
    if (boldLead?.[1]) {
      const name = boldLead[1].trim();
      if (!/tržní|medián|geo|lv\b|parcel|tip|srovnání/i.test(name)) return name;
    }

    const boldDash = text.match(/\*\*([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽa-záčďéěíňóřšťúůýž][^*]{2,60})\*\*\s*[—–-]/u);
    if (boldDash?.[1]) return boldDash[1].trim();

    const ahojPlace = text.match(/\b(?:jasn[eě],?\s+)?(?:mrkneme|podíváme)\s+na\s+\*?\*?([^*.\n!]+)/iu);
    if (ahojPlace?.[1]) {
      const name = ahojPlace[1].replace(/\*\*/g, '').trim();
      if (name.length >= 3) return name;
    }
  }

  return null;
}

/**
 * „Najdi pozemky v této lokalitě“ po dotazu na Řepiště.
 */
export function isContextualMarketQuery(message, history = []) {
  const raw = String(message || '').trim();
  if (!raw) return false;
  if (!looksLikeMarketSearch(raw)) return false;

  const place = resolveLocalityFromChatHistory(history);
  if (!place) return false;

  if (referencesContextualLocality(raw)) return true;

  // Krátký follow-up bez názvu obce: „najdi pozemky“, „co je na trhu“
  if (raw.length < 120 && !/\b(?:ostrava|praha|brno|frydek|mistek)\b/i.test(raw)) {
    return true;
  }

  return false;
}

export function filterListingsByPlace(listings, placeLabel) {
  const needle = foldCzechText(placeLabel);
  if (!needle || needle.length < 3) return listings;
  const parts = needle.split(/\s+/).filter((p) => p.length >= 4);
  const token = parts[0] || needle;

  return listings.filter((l) => {
    const blob = foldCzechText(
      [l.locality, l.title, l.city, l.municipality].filter(Boolean).join(' '),
    );
    return blob.includes(needle) || blob.includes(token);
  });
}
