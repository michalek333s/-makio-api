/**
 * Odborné / vzdělávací dotazy makléře — Gemini chat, NE GeoPas / Radar.
 * Stavařina, právo, finance, marketing, psychologie vyjednávání.
 *
 * Pozn.: u češtiny nepoužívat trailing \b za diakritikou (í/á/…) — JS \b je ASCII-only.
 */

const PARCEL_NUM_RE = /\b(\d{1,6})\s*\/\s*(\d{1,4})\b/;

const HOWTO_LEAD_RE =
  /^\s*(?:jak\s+(?!je\b)|jak[aá]\s+je|co\s+(?:je|znamená|způsobuje|musí|musím|obsahuje|víš\s+o|zkontrolovat)|proč|kdy|kolik|můžu|mohu|je\s+možné|má\s+smysl|v\s+čem\s+je\s+rozdíl|jaký\s+je\s+rozdíl|vysvětli|popiš|porovnej|srovnej|nastav(?:it)?|spočítej|spočítat|odhadni|checklist)/iu;

const HOWTO_VERB_RE =
  /(?:pozn[aá]m|poznat|odhalit|zjistit|lišit|rozlišit|rozpoznat|ověřit\s+(?:že|zda)|určit\s+(?:zda|jestli)|nastavit|spočíta|odhadnout)/iu;

/** Široký okruh makléřské expertízy (20 let praxe). */
const EXPERT_TOPIC_RE =
  /(?:vzlínající|vlhkost|vlhk|radon|azbest|plísn|plíseň|trhlina|statick|tepeln(?:ý|á|é|ých|ého)?\s+most\w*|tepeln(?:é|ého)?\s+čerpadl|rosný\s+bod|kondenzac|porotherm|ytong|heluz|penb|rekuperac|fasád|zatepl|hydroizol|střech|podkrov|panelov(?:ý|ých|é)?\s+dom|cihlov|injektáž|podřezání\s+zdiva|čern(?:á|é)\s+stavb|kolaudac|283\/2021|územní\s+plán|územním\s+plán|stav(?:ební|ebně)\s+povolení|ltv|dti|dsti|dscr|bonit|úvěr|úrok|sazeb|splatk|anuit|ltv|dsti|yield|výnos|gross|net\s+yield|cash\s*flow|roi|irr|hypoték|refinanc|americk(?:á|é)\s+hypoték|fixac|stavební\s+spoř|meziúvěr|vinkulac|odhad\s+bank|bonit|daň\s+z\s+příjmu|osvobození\s+od\s+dan|odpis(?:y|ů)|dph|sosbk|věcn(?:é|a)\s+břemeno|předkupní|exekuc|sjm|společné\s+jmění|rezervační\s+smlouv|smlouv[aě]\s+o\s+smlouvě\s+budoucí|kupní\s+smlouv|advokátní\s+úschov|vinkulac|nabídkov(?:á|ou)\s+cen|realizační\s+cen|cenov(?:á|ou)\s+strateg|homestaging|inzerát|cílov(?:á|ou)\s+skupin|anchoring|flinching|námitk|vyjednáván|safety\s*score|skóre\s+bezpečnost|povode[nň]|záplavov(?:á|é)\s+zón|q100|q20|q5|záplavov(?:é|ého)\s+územ|hluk|lden|lnight|dopravní\s+provoz|kriminalit|bezpečnost\s+lokalit|nezaměstnan|demograf|inženýrsk(?:é|ých)\s+sít|přípojk|kanalizac|vodovod|stavebn(?:í|ého)\s+pozemk|zastaviteln|zastavěn|poddolovan|sesuv|geolog|notář|katastr(?:ální)?\s+poplat|nájemní\s+smlouv|výpověď\s+nájmu|podnájem|občansk(?:á|ou)\s+vybavenost|poi\b|školk|mhd|zdravotnick)/iu;

const MATERIALS_COMPARE_RE =
  /(?:porovnej|srovnej|rozdíl\s+mezi).{0,40}(?:porotherm|ytong|heluz|dřevo|cihl|panel|sip|sendvič)/iu;

const PRICING_ADVICE_RE =
  /(?:nastav(?:it)?|nastavení|jak\s+(?:cenit|nacenit)|nabídkov(?:á|ou)\s+cen|realizační\s+cen|cenov(?:á|ou)\s+strateg|kolik\s+(?:má\s+)?stát|kolik\s+stoj[ií]|odhad\s+ceny)/iu;

const TAX_FINANCE_RE =
  /(?:daň\s+z\s+příjmu|osvobození\s+(?:od\s+)?dan|po\s+\d{1,2}\s*\.?\s*lete(?:ch|ch)|2\s*rok(?:y|ů)\s+bydlišt|ltv|dsti|yield|hypoték)/iu;

const EXPLICIT_GEOPAS_RE =
  /(?:analyz(?:uj|ovat)\s+(?:nemovitost|adresu|parcelu|lískovec|\d)|katastr(?:em)?|geopas|parcela\s+\d|\blv\b\s+(?:pro|u|na)|list\s+vlastnictví|vlastník\s+(?:je|nemovitosti))/iu;

/** Věk stavby / „po X letech“ — ne adresa. */
export function mentionsBuildingAgeNotAddress(message) {
  const m = String(message || '');
  return (
    /(?:domu|dům|stavb[aěy]|objektu|stře[sš]e|fasád)\s+z\s+\d{1,3}\s*\.?\s*let/iu.test(m) ||
    /po\s+\d{1,2}\s*\.?\s*lete(?:ch|ch)/iu.test(m)
  );
}

/** Dispozice 2+kk / 3+kk — ne číslo popisné. */
export function mentionsDispositionNotAddress(message) {
  return /\d{1,2}\s*\+\s*kk/iu.test(String(message || ''));
}

export function isGeneralExpertQuery(message) {
  const m = String(message || '').trim();
  if (!m || m.length < 8) return false;

  // Explicitní katastr s cílem — ne expert
  if (PARCEL_NUM_RE.test(m) && /(?:parcela|lv|katastr|analyz)/iu.test(m)) return false;
  if (EXPLICIT_GEOPAS_RE.test(m) && /\d/.test(m) && !mentionsDispositionNotAddress(m)) return false;

  if (MATERIALS_COMPARE_RE.test(m)) return true;
  if (PRICING_ADVICE_RE.test(m) && !/(?:na\s+trhu|fsbo|bezrealitky|sreality|radar)/iu.test(m)) {
    return true;
  }
  if (mentionsDispositionNotAddress(m) && /(?:kolik|cena|stoj|cenit|nacenit|nabídkov)/iu.test(m)) {
    return true;
  }
  if (TAX_FINANCE_RE.test(m) && HOWTO_LEAD_RE.test(m)) return true;

  if (/^\s*jak\s+(?:pozn[aá]m|poznat|odhalit|zjistit|liší|rozlišit|postupovat|nastavit|cenit|nacenit)/iu.test(m)) {
    return true;
  }

  if (/^\s*(?:co\s+(?:je|znamená|musí|musím|zkontrolovat)|vysvětli|popiš)/iu.test(m) && EXPERT_TOPIC_RE.test(m)) {
    return true;
  }

  if (mentionsBuildingAgeNotAddress(m)) {
    if (HOWTO_LEAD_RE.test(m) || HOWTO_VERB_RE.test(m) || EXPERT_TOPIC_RE.test(m)) return true;
  }

  if (HOWTO_LEAD_RE.test(m) && (HOWTO_VERB_RE.test(m) || EXPERT_TOPIC_RE.test(m))) return true;

  if (EXPERT_TOPIC_RE.test(m) && HOWTO_LEAD_RE.test(m)) return true;

  // „má smysl …“ bez nutnosti topic keyword (investiční byt, tepelné čerpadlo…)
  if (/^\s*má\s+smysl/iu.test(m) && !/(?:najdi|fsbo|na\s+trhu|radar)/iu.test(m)) {
    return true;
  }

  return false;
}

/** Výsledek extrakce adresy vypadá jako celá věta / odborný dotaz — neposílat do GeoPas. */
export function looksLikeGarbagePropertyQuery(query) {
  const q = String(query || '').trim();
  if (!q || q.length < 3) return true;
  if (q.length > 55) return true;
  if (/(?:jak|pozn[aá]m|poznat|vlhkost|vzlínající|co\s+víš|informace|proč|můžu|mohu|kolik|stoj[ií]|cena|daň)/iu.test(q)) {
    return true;
  }
  if (/\d+\s*\+\s*kk/iu.test(q)) return true;
  if (q.split(/\s+/).length > 6) return true;
  return false;
}
