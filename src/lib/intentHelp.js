/**
 * Když makléř napíše nesrozumitelně / s překlepy, nabídni konkrétní odhady záměru
 * místo generického „napište lokalitu“.
 */

import {
  extractNewClientNameFromUserMessage,
  looksLikeNewClientCommand,
  isFuzzyAddVerb,
  isFuzzyKlientWord,
  foldToken,
} from './extractClientNameFromIntent.js';
import {
  looksLikeLocalityInfoQuery,
  extractLocalityNameFromMessage,
} from './localityInfoQuery.js';
import {
  isContextualMarketQuery,
  resolveLocalityFromChatHistory,
  looksLikeMarketSearch,
  referencesContextualLocality,
} from './chatContextLocality.js';
import { inferPropertyTypeFromChat } from './chatIntent.js';
import { isGeneralExpertQuery } from './generalExpertQuery.js';

const GENERIC_CLARIFY_RE =
  /potřebuji upřesnit|napište\s+\*\*lokalitu\*\*|napište lokalitu|zpracov[aá]no\.?\s*potřebujete|omlouvám?\s+se|omluvte\s+m[ěe]|v\s+textu\s+je\s+překlep|chyby\s+se\s+stávají|diktát\s+se\s+stává/i;

export function isGenericClarifyResponse(text) {
  return GENERIC_CLARIFY_RE.test(String(text || ''));
}

function pushUnique(steps, step) {
  const key = `${step.actionType}::${step.label}`;
  if (steps.some((s) => `${s.actionType}::${s.label}` === key)) return;
  steps.push(step);
}

/** Trh / Radar — ne „porovnej Porotherm“ ani cenová rada. */
function looksLikeMarket(msg) {
  if (isGeneralExpertQuery(msg)) return false;
  if (/(?:porotherm|ytong|heluz|azbest|vlhkost|tepeln)/iu.test(msg)) return false;
  return /(?:na\s+)?trhu|investic|nab[ií]dk|radar|fsbo|bezrealitky|sreality|byt[yu]?\s+v\s+|domy\s+v\s+|pozemk|ostrav|brn[oe]|praha|frydek|fr[yý]dek|najdi|vyhledej|hledej|uk[aá]z|porovnej\s+nab[ií]dk|srovnej\s+nab[ií]dk/i.test(
    msg,
  );
}

function looksLikeProperty(msg) {
  return /katastr|parcela|lv\b|analyzuj|geopas|adres[aeu]|ulice|m[aá]nesov/i.test(msg);
}

function looksLikeCalendar(msg) {
  return /sch[uů]zk|hovor|kalend[aá][rř]|agend|napl[aá]n|z[ií]tra|dnes|poz[ií]t[rř]i|\d{1,2}:\d{2}/i.test(
    msg,
  );
}

/**
 * @param {string} message
 * @param {{ activeClientName?: string, clients?: Array<{ name?: string }>, history?: object[] }} [ctx]
 * @returns {{ chatResponse: string, nextSteps: object[], intent: string, isNewClient?: boolean, targetClientName?: string, client?: object }}
 */
export function buildIntentHelp(message, ctx = {}) {
  const msg = String(message || '').trim();
  const active = String(ctx.activeClientName || '').trim();
  const history = Array.isArray(ctx.history) ? ctx.history : [];
  const steps = [];
  const extracted = extractNewClientNameFromUserMessage(msg);
  const fold = (t) =>
    String(t || '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase();
  const activeMentioned =
    Boolean(active) &&
    active
      .split(/\s+/)
      .filter((p) => p.length > 2)
      .every((p) => fold(msg).includes(fold(p)));

  if (isContextualMarketQuery(msg, history)) {
    const place = resolveLocalityFromChatHistory(history) || 'lokalitě z chatu';
    const propertyType = inferPropertyTypeFromChat(msg);
    const typeLabel =
      propertyType === 'pozemky' ? 'pozemky' : propertyType === 'domy' ? 'domy' : 'byty';
    return {
      intent: 'market_scan',
      chatResponse:
        `Beru to jako **${typeLabel}** v **${place}**. ` +
        `Projdu Radar cache a vypíšu, co dává smysl pro náběr nebo investici.`,
      nextSteps: [
        {
          label: `Radar — ${typeLabel} · ${place}`,
          actionType: 'RADAR',
          suggestedMessage: msg,
        },
      ],
    };
  }

  if (referencesContextualLocality(msg) && looksLikeMarketSearch(msg)) {
    const place = resolveLocalityFromChatHistory(history);
    if (place) {
      const propertyType = inferPropertyTypeFromChat(msg);
      return {
        intent: 'market_scan',
        chatResponse:
          `Beru **${place}** z naší konverzace. Projdu nabídky (${propertyType}) v Radar cache.`,
        nextSteps: [
          {
            label: `Radar — ${place}`,
            actionType: 'RADAR',
            suggestedMessage: msg,
          },
        ],
      };
    }
  }

  if (extracted || looksLikeNewClientCommand(msg)) {
    const name = extracted || 'nový kontakt';
    return {
      intent: 'crm_action',
      isNewClient: true,
      targetClientName: extracted || '',
      client: extracted
        ? {
            firstName: extracted.split(/\s+/).slice(0, -1).join(' ') || '',
            lastName: extracted.split(/\s+/).pop() || extracted,
            type: 'Zájemce',
            priority: 'warm',
          }
        : {},
      chatResponse:
        extracted
          ? `Ukládám **${extracted}** do CRM. Doplňte telefon a e-mail, nebo zvolte „Později“.`
          : `Vypadá to na **nového klienta do CRM**. Napište jméno ve tvaru „přidej klienta Jméno Příjmení“, nebo vyberte níže.`,
      nextSteps: [
        {
          label: extracted ? `Uložit — ${extracted}` : 'Přidat klienta do CRM',
          actionType: 'CLIENT',
          suggestedMessage: extracted
            ? `přidej klienta ${extracted}`
            : 'přidej klienta ',
        },
      ],
    };
  }

  if (looksLikeLocalityInfoQuery(msg)) {
    const place = extractLocalityNameFromMessage(msg) || 'lokalitu';
    return {
      intent: 'locality_info',
      chatResponse:
        `Beru to jako dotaz na **lokalitu ${place}** — shrnu charakter místa, pro koho se hodí a co ověřit na místě. ` +
        `Katastr konkrétní parcely spustím až když napíšete **adresu nebo č.p.**`,
      nextSteps: [
        {
          label: `Analyzovat adresu v ${place}`,
          actionType: 'ANALYZE_PROPERTY',
          suggestedMessage: `${place} 310`,
        },
      ],
    };
  }

  // Fuzzy: někde ve větě je „přidej…“ ale jméno nešlo vytáhnout
  const tokens = msg.split(/\s+/).filter(Boolean);
  const hasAdd = tokens.some((t) => isFuzzyAddVerb(t));
  const hasKlient = tokens.some((t) => isFuzzyKlientWord(t));
  if (hasAdd && hasKlient) {
    pushUnique(steps, {
      label: 'Přidat klienta (doplnit jméno)',
      actionType: 'MESSAGE',
      suggestedMessage: 'přidej klienta ',
    });
  } else if (looksLikeCalendar(msg)) {
    pushUnique(steps, {
      label: activeMentioned ? `Naplánovat hovor — ${active}` : 'Naplánovat hovor / schůzku',
      actionType: 'CALENDAR',
      suggestedMessage: activeMentioned
        ? `Naplánuj zítra hovor s ${active} od 10:00`
        : 'Naplánuj zítra hovor od 10:00',
    });
  } else if (looksLikeMarket(msg)) {
    pushUnique(steps, {
      label: 'Radar — nabídky na trhu',
      actionType: 'RADAR',
      suggestedMessage: 'Moravskoslezský',
    });
  } else if (looksLikeProperty(msg)) {
    pushUnique(steps, {
      label: 'Analyzovat nemovitost (katastr)',
      actionType: 'ANALYZE_PROPERTY',
      suggestedMessage: msg,
    });
  } else if (activeMentioned) {
    pushUnique(steps, {
      label: `SMS — ${active}`,
      actionType: 'MESSAGE',
      suggestedMessage: active,
    });
  }

  const guesses = [];
  if (hasAdd || hasKlient) guesses.push('uložit **klienta do CRM**');
  if (looksLikeCalendar(msg)) guesses.push('**schůzku / hovor** do agendy');
  if (looksLikeMarket(msg)) guesses.push('**přehled trhu** (Radar)');
  if (looksLikeProperty(msg)) guesses.push('**analýzu nemovitosti**');
  if (activeMentioned) guesses.push(`práci s klientem **${active}**`);

  const guessLine =
    guesses.length > 0
      ? `Tipuju, že chcete: ${guesses.slice(0, 2).join(' nebo ')}.`
      : 'Beru to prakticky: napište jméno klienta, město, nebo adresu — hned to posunu.';

  return {
    intent: 'clarification_needed',
    chatResponse:
      `${guessLine}\n\n` +
      (steps.length
        ? `Vyberte tlačítko níže, nebo dopište jednu větu.`
        : `Dopište jméno, město nebo adresu — hned to posunu.`),
    nextSteps: steps.slice(0, 2),
  };
}

/**
 * Pokud AI vrátila prázdnou / generickou clarifikaci, nahraď chápavou nápovědou.
 * Mutuje `parsed`.
 */
export function applyIntentHelpIfNeeded(parsed, message, ctx = {}) {
  if (!parsed || typeof parsed !== 'object') return parsed;

  // Odborný dotaz (stavařina / právo / finance) — nikdy nepřepisovat na Radar tipy
  if (isGeneralExpertQuery(message)) {
    if (
      parsed.intent === 'clarification_needed' ||
      !String(parsed.chatResponse || '').trim() ||
      isGenericClarifyResponse(parsed.chatResponse)
    ) {
      parsed.intent = 'general_chat';
    }
    return parsed;
  }

  const extracted = extractNewClientNameFromUserMessage(message);
  if (extracted) {
    const needs =
      parsed.intent === 'clarification_needed' ||
      !String(parsed.chatResponse || '').trim() ||
      isGenericClarifyResponse(parsed.chatResponse);
    if (needs || looksLikeNewClientCommand(message)) {
      const parts = extracted.split(/\s+/).filter(Boolean);
      parsed.intent = 'crm_action';
      parsed.isNewClient = true;
      parsed.targetClientName = extracted;
      parsed.client = {
        ...(parsed.client || {}),
        firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : '',
        lastName: parts.length ? parts[parts.length - 1] : extracted,
        type: parsed.client?.type || 'Zájemce',
        priority: parsed.client?.priority || 'warm',
      };
      if (needs) {
        parsed.chatResponse =
          `Ukládám **${extracted}** do CRM. Doplňte telefon a e-mail, nebo zvolte „Později“.`;
        parsed.nextSteps = [
          {
            label: `Doplň kontakt — ${extracted}`,
            actionType: 'CLIENT',
            suggestedMessage: extracted,
          },
        ];
      }
    }
    return parsed;
  }

  const intent = String(parsed.intent || '');
  const response = String(parsed.chatResponse || '');
  const needsHelp =
    intent === 'clarification_needed' ||
    !response.trim() ||
    isGenericClarifyResponse(response);

  if (!needsHelp) return parsed;

  const help = buildIntentHelp(message, ctx);
  parsed.intent = help.intent;
  parsed.chatResponse = help.chatResponse;
  parsed.nextSteps = help.nextSteps;
  if (help.isNewClient) {
    parsed.isNewClient = true;
    parsed.targetClientName = help.targetClientName;
    parsed.client = { ...(parsed.client || {}), ...(help.client || {}) };
  }
  return parsed;
}
