/**
 * nextSteps v chatu: max 2, jen k aktuálnímu případu.
 * Žádné cizí CRM kontakty, žádné vycpávky Radar/CRM „pro jistotu“.
 */

import { isRadarMarketQuery, resolveRegionFromChat } from '../lib/chatIntent.js';
import { extractNewClientNameFromUserMessage } from '../lib/extractClientNameFromIntent.js';
import { isGeneralExpertQuery } from '../lib/generalExpertQuery.js';

export const MAX_CHAT_NEXT_STEPS = 2;

function fold(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

function hasAction(steps, pattern) {
  return (steps || []).some((s) => pattern.test(String(s.actionType || '')));
}

function pushUnique(steps, step) {
  if (!step || !step.actionType) return;
  const key = `${step.actionType}::${step.label}`;
  if (steps.some((s) => `${s.actionType}::${s.label}` === key)) return;
  steps.push(step);
}

function samePerson(a, b) {
  const fa = fold(a).replace(/\s+/g, ' ');
  const fb = fold(b).replace(/\s+/g, ' ');
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  const pa = fa.split(' ').filter((p) => p.length > 1);
  const pb = fb.split(' ').filter((p) => p.length > 1);
  if (pa.length >= 2 && pb.length >= 2) {
    return pa.every((p) => pb.includes(p)) || pb.every((p) => pa.includes(p));
  }
  return pa.some((p) => pb.includes(p) && p.length >= 4);
}

function mentionsName(text, name) {
  if (!name || !text) return false;
  const t = fold(text);
  const parts = fold(name)
    .split(/\s+/)
    .filter((p) => p.length > 2);
  if (!parts.length) return false;
  return parts.every((p) => t.includes(p));
}

/** Jméno z labelu typu „Doplň kontakt — Barbora Nováková“ / „SMS — Petr Novák“. */
export function extractNameFromStepLabel(label) {
  const s = String(label || '').trim();
  if (!s) return '';
  const m = s.match(/[—–\-]\s*([^—–\-]+)$/);
  if (m) {
    const name = m[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (/^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][\p{L}'’-]*(?:\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][\p{L}'’-]*){0,3}$/u.test(name)) {
      return name;
    }
  }
  return '';
}

function stepImpliesClient(step) {
  const fromLabel = extractNameFromStepLabel(step?.label);
  if (fromLabel) return fromLabel;
  const sug = String(step?.suggestedMessage || '').trim();
  if (
    sug &&
    sug.length < 60 &&
    /^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][\p{L}'’-]*(?:\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][\p{L}'’-]*){0,3}$/u.test(sug) &&
    !/radar|moravskoslez|ostrava|praha|brno|analyz|naplánuj/i.test(sug)
  ) {
    return sug;
  }
  return '';
}

/**
 * Kdo je „případ“ této odpovědi — jen jméno z chatu / CRM akce, ne náhodný vybraný klient v UI.
 */
export function resolveFocusClientName({
  parsed = {},
  message = '',
  activeClientName = '',
  history = [],
  currentScreen = null,
} = {}) {
  const target = String(parsed?.targetClientName || '').trim();
  if (target) return target;

  const fromMsg = extractNewClientNameFromUserMessage(message);
  if (fromMsg) return fromMsg;

  const hist = Array.isArray(history) ? history : [];
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const turn = hist[i];
    const blob = `${turn?.content || turn?.text || turn?.chatResponse || ''} ${turn?.targetClientName || ''}`;
    const fromHist = extractNewClientNameFromUserMessage(blob) || String(turn?.targetClientName || '').trim();
    if (fromHist) return fromHist;
  }

  const screen = currentScreen && typeof currentScreen === 'object' ? currentScreen : null;
  const screenName = String(screen?.name || '').trim();
  const active = String(activeClientName || '').trim();

  if (screen?.type === 'client' && screenName) {
    if (!active || samePerson(screenName, active) || mentionsName(message, screenName)) {
      return screenName;
    }
  }

  if (active && mentionsName(message, active)) return active;

  return '';
}

/**
 * Odstraní kroky na cizí klienty a ořízne na max 2.
 * Povolí 0 kroků, pokud nic nesedí.
 */
export function filterAndCapNextSteps(steps, { focusClientName = '', message = '', max = MAX_CHAT_NEXT_STEPS } = {}) {
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const focus = String(focusClientName || '').trim();
  const msg = String(message || '');

  const filtered = list.filter((step) => {
    const implied = stepImpliesClient(step);
    if (!implied) return true;
    if (focus) return samePerson(implied, focus) || mentionsName(msg, implied);
    return mentionsName(msg, implied);
  });

  return filtered.slice(0, Math.max(0, max));
}

function pickPrimarySteps(parsed, message, focus, screen) {
  const intent = String(parsed?.intent || 'general_chat');
  const msg = String(message || '');
  const steps = [];

  if (intent === 'crm_action' && (parsed.isNewClient || focus)) {
    const name = focus || parsed.targetClientName || '';
    pushUnique(steps, {
      label: name ? `Doplň kontakt — ${name}` : 'Doplň kontakt klienta',
      actionType: 'CLIENT',
      suggestedMessage: name,
    });
    if (name && parsed.event?.title) {
      pushUnique(steps, {
        label: `Naplánovat follow-up — ${name}`,
        actionType: 'CALENDAR',
        suggestedMessage: `Naplánuj zítra hovor s ${name} od 10:00`,
      });
    } else if (name) {
      pushUnique(steps, {
        label: `Navrhnout SMS — ${name}`,
        actionType: 'MESSAGE',
        suggestedMessage: name,
      });
    }
    return steps.slice(0, MAX_CHAT_NEXT_STEPS);
  }

  if (intent === 'radar_scan' || intent === 'market_scan' || isRadarMarketQuery(msg)) {
    const region = parsed.radarRegion || resolveRegionFromChat(msg);
    pushUnique(steps, {
      label: `Otevřít Radar — ${region}`,
      actionType: 'RADAR',
      suggestedMessage: region,
    });
    if (focus) {
      pushUnique(steps, {
        label: `Spárovat s klientem — ${focus}`,
        actionType: 'CLIENT',
        suggestedMessage: focus,
      });
    }
    return steps.slice(0, MAX_CHAT_NEXT_STEPS);
  }

  if (intent === 'property_analysis' || parsed.propertyQuery) {
    const q = parsed.propertyQuery || msg;
    pushUnique(steps, {
      label: 'Detailní analýza (GeoPas)',
      actionType: 'ANALYZE_PROPERTY',
      suggestedMessage: q,
    });
    if (focus) {
      pushUnique(steps, {
        label: `Vázat na klienta — ${focus}`,
        actionType: 'CLIENT',
        suggestedMessage: focus,
      });
    }
    return steps.slice(0, MAX_CHAT_NEXT_STEPS);
  }

  if (intent === 'locality_info') {
    const place = parsed.municipalityName || msg;
    pushUnique(steps, {
      label: 'Analyzovat konkrétní adresu',
      actionType: 'ANALYZE_PROPERTY',
      suggestedMessage: typeof place === 'string' && place.length < 80 ? `${place} 310` : msg,
    });
    return steps.slice(0, MAX_CHAT_NEXT_STEPS);
  }

  if (/insolvenc|exekuc|aml|pep|sankc/i.test(msg)) {
    pushUnique(steps, {
      label: focus ? `AML / insolvence — ${focus}` : 'Prověřit insolvenci / AML',
      actionType: 'CHECK_INSOLVENCY',
      suggestedMessage: focus || msg,
    });
    return steps.slice(0, MAX_CHAT_NEXT_STEPS);
  }

  if (/smlouv|rezervac|úschov/i.test(msg)) {
    pushUnique(steps, {
      label: 'Vyplnit smlouvu',
      actionType: 'CONTRACT',
      suggestedMessage: focus || '',
    });
    return steps.slice(0, MAX_CHAT_NEXT_STEPS);
  }

  if (/inzerát|propagac|text na sreality|homestaging|staging/i.test(msg)) {
    pushUnique(steps, {
      label: /staging|fot/i.test(msg) ? 'AI staging fotek' : 'Tvorba inzerátu',
      actionType: /staging|fot/i.test(msg) ? 'STAGING' : 'LISTING',
      suggestedMessage: '',
    });
    return steps.slice(0, MAX_CHAT_NEXT_STEPS);
  }

  if (screen?.type === 'client' && focus) {
    pushUnique(steps, {
      label: `SMS / follow-up — ${focus}`,
      actionType: 'MESSAGE',
      suggestedMessage: focus,
    });
    return steps.slice(0, MAX_CHAT_NEXT_STEPS);
  }

  // Obecná / odborná rada bez operativní akce → žádná tlačítka
  return steps;
}

/**
 * Složí finální nextSteps: nejdřív primární krok k intentu, pak relevantní návrhy z modelu.
 * Max MAX_CHAT_NEXT_STEPS. Nula je OK (odborná rada bez operativní akce).
 */
export function enrichBrokerNextSteps(
  parsed,
  { message = '', activeClientName = '', currentScreen = null, history = [] } = {},
) {
  if (!parsed || typeof parsed !== 'object') return parsed;

  const screen = currentScreen && typeof currentScreen === 'object' ? currentScreen : null;
  const focus = resolveFocusClientName({
    parsed,
    message,
    activeClientName,
    history,
    currentScreen: screen,
  });

  const primary = pickPrimarySteps(parsed, message, focus, screen);
  const fromModel = filterAndCapNextSteps(parsed.nextSteps, {
    focusClientName: focus,
    message,
    max: MAX_CHAT_NEXT_STEPS,
  });

  const steps = [];
  for (const s of primary) {
    if (steps.length >= MAX_CHAT_NEXT_STEPS) break;
    pushUnique(steps, s);
  }
  for (const s of fromModel) {
    if (steps.length >= MAX_CHAT_NEXT_STEPS) break;
    pushUnique(steps, s);
  }

  parsed.nextSteps = steps.slice(0, MAX_CHAT_NEXT_STEPS);
  return parsed;
}
