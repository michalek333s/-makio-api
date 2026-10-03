/**
 * Chat nesmí omlouvat překlepy ani říkat „nevím“.
 * Tichá oprava záměru — makléř vidí jen odpověď a další krok.
 */

const BANNED_LINE =
  /omlouvám?\s+se|omluvte\s+m[ěe]|pardon,?\s+ale|promiňte|v\s+textu\s+je\s+překlep|překlep(y|ů)?(\s+\/\s+diktát)?(\s+se\s+stává)?|chyby\s+se\s+stávají|diktát\s+se\s+stává|nerozumím(\s+vám)?|nejsem\s+si\s+jist|jako\s+ai|jako\s+jazykový\s+model|nejsem\s+schopen|nemohu\s+pomoci|zpracováno\.?/i;

const BANNED_PHRASE =
  /\s*\((překlep|diktát)[^)]*\)\.?/gi;

const WEAK_OPENERS = [
  /^omlouvám?\s+se[^.!?\n]*[.!?]?/i,
  /^omluvte\s+m[ěe][^.!?\n]*[.!?]?/i,
  /^pardon[^.!?\n]*[.!?]?/i,
  /^promiňte[^.!?\n]*[.!?]?/i,
  /^z\s+textu\s+to\s+není[^.!?\n]*[.!?]?/i,
  /^i\s+když\s+byl\s+v\s+textu\s+překlep[^.!?\n]*[.!?]?/i,
  /^i\s+přes\s+překlep[^.!?\n]*[.!?]?/i,
];

export function looksLikeApologyOrTypoTalk(text) {
  return BANNED_LINE.test(String(text || ''));
}

export function sanitizeChatVoice(text) {
  let out = String(text || '').trim();
  if (!out) return out;

  for (const re of WEAK_OPENERS) {
    out = out.replace(re, '').trim();
  }
  out = out.replace(BANNED_PHRASE, ' ').replace(/[ \t]{2,}/g, ' ').trim();

  const lines = out.split(/\n+/).filter((line) => !BANNED_LINE.test(line.trim()));
  out = lines.join('\n\n').trim();

  return out;
}

export function fallbackBrokerAnswer(message = '') {
  const msg = String(message || '').trim();
  if (/hypoték|ltv|dsti|splát/i.test(msg)) {
    return (
      'U hypotéky počítejte **DSTI ~40 %** čistého příjmu a **odhad banky 5–15 % pod kupní cenou**. ' +
      'Nejdřív **předběžné schválení**, teprve pak rezervace. ' +
      'Další krok: spočítat reálnou splátku a ověřit, jestli má klient hotovost na doplatek.'
    );
  }
  if (/cen[auy]|nabídkov|prodej/i.test(msg)) {
    return (
      'Nabídková cena v ČR bývá **5–12 % nad realizační**. ' +
      'Nastavte cenu podle cíle (rychlý prodej vs. max výnos) a srovnejte **Kč/m²** v lokalitě. ' +
      'Další krok: otevřít Radar v daném městě a porovnat 3–5 nabídek.'
    );
  }
  if (/klient|kontakt|crm/i.test(msg)) {
    return (
      'Beru to jako práci s **klientem v CRM**. Uložím, co jde, a doplníme telefon / e-mail. ' +
      'Další krok: otevřít kartu klienta a napsat krátký follow-up.'
    );
  }
  return (
    'Jdu rovnou k věci: z praxe bych teď volil **jeden konkrétní krok** — CRM (uložit kontakt), ' +
    '**Radar** (co je na trhu), nebo **analýzu adresy** (katastr / rizika). ' +
    'Vyberte níže, nebo dopište jméno, město nebo adresu — hned to posunu.'
  );
}

export function ensureUsefulChatResponse(parsed, message) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  let text = sanitizeChatVoice(parsed.chatResponse);
  if (!text || text.length < 24 || looksLikeApologyOrTypoTalk(text)) {
    text = fallbackBrokerAnswer(message);
    if (parsed.intent === 'clarification_needed') {
      parsed.intent = 'general_chat';
    }
  }
  parsed.chatResponse = text;
  return parsed;
}
