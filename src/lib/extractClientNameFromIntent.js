import { normalizeCzechPersonName, stripPersonNameTail } from './czechPersonName.js';

/**
 * Robustní rozpoznání „přidej klienta …“ včetně překlepů a diktátu.
 * FE vždy přepíše AI, když tento extraktor najde jméno — funguje trvale, ne jen na 1–2 tvary.
 */

const DEST_FOLD = new Set([
  'databaze',
  'crm',
  'db',
  'apky',
  'aplikace',
  'appky',
  'makio',
  'systemu',
  'aplikaci',
]);

const ADD_VERB_CANON = [
  'pridej',
  'pridat',
  'pridejte',
  'pridam',
  'prideme',
  'prid',
  'zaloz',
  'zalozit',
  'eviduj',
  'vytvor',
  'vytvorit',
  'vytvorte',
  'vytvorim',
];

const KLIENT_CANON = [
  'klient',
  'klienta',
  'klientu',
  'klienty',
  'klientku',
  'klientka',
  'kontakt',
  'kontakta',
];

const STOP_AFTER_NAME = new Set([
  'do',
  'prosím',
  'prosim',
  'diky',
  'děkuji',
  'dekuji',
]);

/**
 * Levenshtein vzdálenost.
 */
export function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const cols = t.length + 1;
  let prev = new Array(cols);
  let curr = new Array(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[t.length];
}

export function foldToken(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cleanToken(t) {
  return String(t || '').replace(/^[„"'(]+|[.,!?)"'“]+$/gu, '');
}

function maxTypoDist(len) {
  if (len <= 4) return 1;
  if (len <= 6) return 2;
  return 3; // klineta, kleitna, pridattypo…
}

function fuzzyMatchesCanon(token, canonList) {
  const f = foldToken(token);
  if (!f || f.length < 3 || f.length > 14) return false;
  for (const canon of canonList) {
    const c = foldToken(canon);
    if (editDistance(f, c) <= maxTypoDist(Math.max(f.length, c.length))) return true;
  }
  return false;
}

/** „přidej“ / „založ“ / „eviduj“ i s překlepem */
export function isFuzzyAddVerb(token) {
  const f = foldToken(token);
  if (!f || f.length < 3) return false;
  if (fuzzyMatchesCanon(f, ADD_VERB_CANON)) return true;
  // typické kořeny
  return /^(prid|pride|zaloz|evid|vytvor)/.test(f);
}

/** „klient“ / „kontakt“ i s překlepem (klineta, klenta, klietna, …) */
export function isFuzzyKlientWord(token) {
  const f = foldToken(token);
  if (!f || f.length < 4 || f.length > 12) return false;
  if (DEST_FOLD.has(f) || /^(byt|dum|dumy|pozemek|schuzka|hovor|email|telefon)$/.test(f)) {
    return false;
  }
  if (fuzzyMatchesCanon(f, KLIENT_CANON)) return true;
  // silné kořeny i při větším překlepu
  return (
    /^kli[e]?n/.test(f) ||
    /^klent/.test(f) ||
    /^klinet/.test(f) ||
    /^kleitn/.test(f) ||
    /^klint/.test(f) ||
    /^kontak/.test(f)
  );
}

function isNewAdj(token) {
  return /^(noveho|novou|novy|nova)$/i.test(foldToken(token));
}

function isMasculineKlientToken(token) {
  const f = foldToken(token);
  if (/klientk|kontakt/.test(f)) return false;
  return isFuzzyKlientWord(token);
}

const NOT_A_PERSON = new Set([
  'byt',
  'byty',
  'dum',
  'domy',
  'pozemek',
  'pozemky',
  'schuzka',
  'hovor',
  'email',
  'telefon',
  'sms',
  'inzerat',
  'nabidka',
  'poptavka',
  'ostrava',
  'brno',
  'praha',
  'olomouc',
  'plzen',
  'liberec',
]);

function looksLikePersonNameToken(token) {
  const f = foldToken(token);
  if (!f || f.length < 2) return false;
  if (DEST_FOLD.has(f) || STOP_AFTER_NAME.has(f) || NOT_A_PERSON.has(f)) return false;
  // NEfiltrovat „nový/nová“ — to je běžné české příjmení (Petr Nový).
  // isNewAdj se používá jen při parse „nový klient“ před jménem.
  if (isFuzzyAddVerb(token) || isFuzzyKlientWord(token)) return false;
  if (/^\d+$/.test(f)) return false;
  return /^[a-z]{2,20}$/.test(f);
}

function polishExtractedName(name, klientToken) {
  let out = normalizeCzechPersonName(stripPersonNameTail(name));
  if (!out) return null;

  if (
    klientToken &&
    isMasculineKlientToken(klientToken) &&
    /^jana\s+\S+/iu.test(out) &&
    /ák$/u.test(out.split(/\s+/).pop() || '')
  ) {
    out = normalizeCzechPersonName(`Jan ${out.split(/\s+/).slice(1).join(' ')}`);
  }
  if (/^janu\s+/iu.test(out)) {
    out = normalizeCzechPersonName(`Jana ${out.split(/\s+/).slice(1).join(' ')}`);
  }
  if (/^(databáze|databaze|crm|klient\w*|kontakt\w*|apky|aplikace)$/iu.test(out)) {
    return null;
  }
  return out.length >= 2 ? out : null;
}

function takeNameTokens(tokens, fromIdx) {
  const out = [];
  for (let i = fromIdx; i < tokens.length; i++) {
    const raw = cleanToken(tokens[i]);
    const f = foldToken(raw);
    if (!f) continue;
    if (f === 'do' && i + 1 < tokens.length && DEST_FOLD.has(foldToken(tokens[i + 1]))) break;
    if (DEST_FOLD.has(f) || STOP_AFTER_NAME.has(f)) break;
    if (!looksLikePersonNameToken(raw) && out.length >= 1) break;
    if (!looksLikePersonNameToken(raw)) continue;
    out.push(raw);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Tokenizovaný parse s fuzzy matchingem.
 */
function extractViaFuzzyTokens(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  // A) přidej [nového] klienta~typo Jméno …
  for (let i = 0; i < tokens.length; i++) {
    const verb = cleanToken(tokens[i]);
    if (!isFuzzyAddVerb(verb)) continue;

    let j = i + 1;
    if (j < tokens.length && isNewAdj(cleanToken(tokens[j]))) j += 1;

    let klientToken = null;
    if (j < tokens.length && isFuzzyKlientWord(cleanToken(tokens[j]))) {
      klientToken = cleanToken(tokens[j]);
      j += 1;
    }

    const nameParts = takeNameTokens(tokens, j);
    // s „klient“ stačí 1 token jména; bez něj potřebujeme ≥ 2 (jméno + příjmení)
    if (klientToken && nameParts.length >= 1) {
      const polished = polishExtractedName(nameParts.join(' '), klientToken);
      if (polished) return polished;
    }
    // Bez slova klient: jen když 1. token vypadá jako křestní (ne byt/město)
    if (!klientToken && nameParts.length >= 2) {
      const firstFold = foldToken(nameParts[0]);
      const looksGiven =
        firstFold.length >= 3 &&
        !NOT_A_PERSON.has(firstFold) &&
        !/^(ulice|namesti|parcela)$/.test(firstFold);
      if (looksGiven) {
        const polished = polishExtractedName(nameParts.join(' '), null);
        if (polished) return polished;
      }
    }
  }

  // B) nový klient~typo Jméno
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!isNewAdj(cleanToken(tokens[i]))) continue;
    if (!isFuzzyKlientWord(cleanToken(tokens[i + 1]))) continue;
    const nameParts = takeNameTokens(tokens, i + 2);
    if (!nameParts.length) continue;
    const polished = polishExtractedName(nameParts.join(' '), cleanToken(tokens[i + 1]));
    if (polished) return polished;
  }

  // C) přidej do CRM/apky Jméno
  for (let i = 0; i < tokens.length - 2; i++) {
    if (!isFuzzyAddVerb(cleanToken(tokens[i]))) continue;
    if (foldToken(tokens[i + 1]) !== 'do') continue;
    if (!DEST_FOLD.has(foldToken(tokens[i + 2]))) continue;
    let k = i + 3;
    let klientToken = null;
    if (k < tokens.length && isFuzzyKlientWord(cleanToken(tokens[k]))) {
      klientToken = cleanToken(tokens[k]);
      k += 1;
    }
    const nameParts = takeNameTokens(tokens, k);
    if (nameParts.length < 1) continue;
    const polished = polishExtractedName(nameParts.join(' '), klientToken);
    if (polished) return polished;
  }

  return null;
}

/** Jméno nového klienta z příkazu makléře (překlepy OK). */
export function extractNewClientNameFromUserMessage(raw) {
  return extractViaFuzzyTokens(raw);
}

/** Je zpráva příkazem na založení klienta? */
export function looksLikeNewClientCommand(raw) {
  const s = (raw || '').trim();
  if (!s) return false;
  if (extractNewClientNameFromUserMessage(s)) return true;

  const tokens = s.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (!isFuzzyAddVerb(cleanToken(tokens[i]))) continue;
    let j = i + 1;
    if (j < tokens.length && isNewAdj(cleanToken(tokens[j]))) j += 1;
    if (j < tokens.length && isFuzzyKlientWord(cleanToken(tokens[j]))) return true;
    if (j < tokens.length && foldToken(tokens[j]) === 'do') return true;
  }
  return false;
}

/** @deprecated */
export const KLIENT_WORD =
  'klienta|klientku|klineta|klent[au]|klenta|kleitna|kliena|klietna|klietnu|klientu|klienta?|klient';
