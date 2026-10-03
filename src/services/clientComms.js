/**
 * Lidská komunikace s klienty — SMS / e-mail / WhatsApp návrhy.
 * Sdílené jádro pro /api/ai/sms-draft, email-draft a nurturing AI.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedCommsPrompt = null;
let cachedDealStagesPrompt = null;

export const DEAL_STAGES = {
  FIRST_CONTACT: 'first_contact',
  QUALIFICATION: 'qualification',
  AFTER_VIEWING: 'after_viewing',
  RESERVATION: 'reservation',
  LISTING_PITCH: 'listing_pitch',
  RE_ENGAGE: 're_engage',
  POST_CLOSING: 'post_closing',
};

const DEAL_STAGE_LABELS = {
  [DEAL_STAGES.FIRST_CONTACT]: 'První kontakt (lead)',
  [DEAL_STAGES.QUALIFICATION]: 'Kvalifikace (bonita / motivace)',
  [DEAL_STAGES.AFTER_VIEWING]: 'Po prohlídce',
  [DEAL_STAGES.RESERVATION]: 'Rezervace / financování',
  [DEAL_STAGES.LISTING_PITCH]: 'Náběr / cena (prodávající)',
  [DEAL_STAGES.RE_ENGAGE]: 'Studený kontakt / re-engage',
  [DEAL_STAGES.POST_CLOSING]: 'Po uzavření (referral)',
};

export function getClientCommsPlaybook() {
  if (!cachedCommsPrompt) {
    cachedCommsPrompt = readFileSync(join(__dirname, '../prompts/makio-client-comms.txt'), 'utf8');
  }
  return cachedCommsPrompt;
}

export function getDealStagesPlaybook() {
  if (!cachedDealStagesPrompt) {
    cachedDealStagesPrompt = readFileSync(join(__dirname, '../prompts/makio-deal-stages-comms.txt'), 'utf8');
  }
  return cachedDealStagesPrompt;
}

function softList(client) {
  if (Array.isArray(client?.softData)) return client.softData.map(String).filter(Boolean);
  if (Array.isArray(client?.soft_data)) return client.soft_data.map(String).filter(Boolean);
  return [];
}

function firstName(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)[0] || '';
}

function inferRole(client) {
  const type = String(client?.type || '');
  const interest = String(client?.interest || '');
  const sell = client?.address_property_sell || client?.address_sell;
  const buy = client?.address_property_buy || client?.address_buy;
  if (/prodá|majitel|vlastník/i.test(type) || sell) return 'seller';
  if (/zájem|kupuj/i.test(type) || buy || /hledá|koup/i.test(interest)) return 'buyer';
  if (/nájem/i.test(type) || /nájem/i.test(interest)) return 'tenant';
  return 'unknown';
}

function hasTaskHint(client, re) {
  const tasks = Array.isArray(client?.tasks) ? client.tasks : [];
  return tasks.some((t) => re.test(String(t?.title || t?.text || t || '')));
}

function hasHistoryHint(client, re) {
  const hist = Array.isArray(client?.history) ? client.history : [];
  return hist.some((h) => re.test(String(h?.text || h?.note || h || '')));
}

/**
 * Odhad fáze obchodu z CRM dat (pro tón zprávy klientovi).
 */
export function inferDealStage(client = {}, { purpose = '' } = {}) {
  const explicit = String(client?.dealStage || client?.deal_stage || '').trim();
  if (explicit && Object.values(DEAL_STAGES).includes(explicit)) return explicit;

  const p = String(purpose || '').toLowerCase();
  if (/po prohlídce|prohlídk/i.test(p)) return DEAL_STAGES.AFTER_VIEWING;
  if (/rezervac|financov|hypoték/i.test(p)) return DEAL_STAGES.RESERVATION;
  if (/náběh|exkluziv|cena|nabídkov/i.test(p)) return DEAL_STAGES.LISTING_PITCH;
  if (/re-engage|studen|odložil|později/i.test(p)) return DEAL_STAGES.RE_ENGAGE;
  if (/referral|gratul|převod|uzavř/i.test(p)) return DEAL_STAGES.POST_CLOSING;
  if (/kvalifik|bonit|schválen/i.test(p)) return DEAL_STAGES.QUALIFICATION;
  if (/první kontakt|osloven|lead/i.test(p)) return DEAL_STAGES.FIRST_CONTACT;

  if (hasTaskHint(client, /prohlídk|viewing/i) || hasHistoryHint(client, /prohlídk/i)) {
    return DEAL_STAGES.AFTER_VIEWING;
  }
  if (hasTaskHint(client, /rezervac|hypoték|bank/i)) return DEAL_STAGES.RESERVATION;
  if (hasTaskHint(client, /exkluziv|náběh|cen/i)) return DEAL_STAGES.LISTING_PITCH;

  const role = inferRole(client);
  if (role === 'seller' && (client?.address_property_sell || client?.address_sell)) {
    return DEAL_STAGES.LISTING_PITCH;
  }
  if (role === 'buyer' && (client?.budget || client?.interest)) {
    return DEAL_STAGES.QUALIFICATION;
  }
  if (String(client?.priority || '').toLowerCase() === 'cold') {
    return DEAL_STAGES.RE_ENGAGE;
  }
  return DEAL_STAGES.FIRST_CONTACT;
}

export function getDealStagePurposeHint(stage) {
  const hints = {
    [DEAL_STAGES.FIRST_CONTACT]: 'první kontakt — důvěra, jeden next step, bez tlaku na cenu',
    [DEAL_STAGES.QUALIFICATION]: 'kvalifikace — hypotéka, timeline, motivace, přirozeně ne jako formulář',
    [DEAL_STAGES.AFTER_VIEWING]: 'po prohlídce — pojmenovat pocit, nabídnout druhou prohlídku nebo srovnání',
    [DEAL_STAGES.RESERVATION]: 'rezervace/financování — klid, jasné lhůty, vysvětlit bez paniky',
    [DEAL_STAGES.LISTING_PITCH]: 'náběr prodávajícího — reálná cena, plán prezentace, bez prázdných slibů',
    [DEAL_STAGES.RE_ENGAGE]: 'studený kontakt — vrátit dialog bez viny, možnost odpovědět později',
    [DEAL_STAGES.POST_CLOSING]: 'po uzavření — gratulace, péče, jemná žádost o doporučení',
  };
  return hints[stage] || hints[DEAL_STAGES.FIRST_CONTACT];
}

/**
 * Kontext klienta pro LLM (bez zbytečné PII navíc).
 */
export function buildClientCommsContext(client = {}, { purpose = '', brokerFirstName = '', dealStage = '' } = {}) {
  const soft = softList(client).slice(0, 5);
  const role = inferRole(client);
  const stage = dealStage || inferDealStage(client, { purpose });
  const lines = [
    `Jméno: ${client.name || '—'}`,
    `Křestní: ${firstName(client.name)}`,
    `Role (odhad): ${role === 'seller' ? 'prodávající' : role === 'buyer' ? 'kupující' : role === 'tenant' ? 'nájemce/pronajímatel' : 'neznámá'}`,
    `Fáze obchodu: ${DEAL_STAGE_LABELS[stage] || stage}`,
    `Typ v CRM: ${client.type || '—'}`,
    `Priorita: ${client.priority || '—'}`,
    `Záměr / interest: ${client.interest || '—'}`,
    `Rozpočet: ${client.budget || '—'}`,
    `Kontext: ${client.context || '—'}`,
    `Prodává: ${client.address_property_sell || client.address_sell || '—'}`,
    `Hledá: ${client.address_property_buy || client.address_buy || '—'}`,
    `Soft data: ${soft.length ? soft.join(' · ') : '—'}`,
    `Účel zprávy: ${purpose || getDealStagePurposeHint(stage)}`,
    `Jméno makléře (podpis): ${brokerFirstName || '—'}`,
  ];
  return lines.join('\n');
}

/**
 * System prompt pro draft jedné zprávy.
 * @param {'sms'|'whatsapp'|'email'} channel
 */
export function buildClientMessageSystemPrompt({
  channel = 'sms',
  client,
  purpose = '',
  brokerFirstName = '',
  dealStage = '',
} = {}) {
  const playbook = getClientCommsPlaybook();
  const stagesPlaybook = getDealStagesPlaybook();
  const stage = dealStage || inferDealStage(client, { purpose });
  const ctx = buildClientCommsContext(client, { purpose, brokerFirstName, dealStage: stage });
  const channelHint =
    channel === 'email'
      ? `KANÁL: E-MAIL
Formát výstupu přesně:
SUBJECT: <předmět>
BODY:
<body>`
      : channel === 'whatsapp'
        ? `KANÁL: WHATSAPP (jako SMS — krátké, hovorové, max ~320 znaků)`
        : `KANÁL: SMS (max ~320 znaků, 2–4 věty)`;

  return `${playbook}

── FÁZE OBCHODU (použij tón pro: ${DEAL_STAGE_LABELS[stage] || stage}) ──
${stagesPlaybook}

── KONKRÉTNÍ ZAKÁZKA ──
${channelHint}

KLIENT:
${ctx}

Napiš jednu hotovou zprávu. Žádný meta-komentář.`.trim();
}

/**
 * Prompt pro AI obohacení nurturing triggerů.
 */
export function buildNurturingEnhanceSystemPrompt() {
  return `${getClientCommsPlaybook()}

── ÚKOL: NURTURING TRIGGERY ──
Dostaneš CRM klienty a existující triggery. Vrať POUZE validní JSON pole (max 8 položek):
{
  "id": "string",
  "type": "string",
  "title": "string (pro makléře, krátký)",
  "body": "string (1 věta pro makléře — proč teď)",
  "clientId": "string|null",
  "clientName": "string",
  "eventId": "string|number|null",
  "action": "MESSAGE|CALENDAR|CLIENT",
  "priority": 1-100,
  "suggestedMessage": "string (hotová SMS/WhatsApp max 320 znaků — LIDSKY, ne roboticky)"
}

Pravidla navíc:
- suggestedMessage = text, který makléř rovnou pošle klientovi (ne instrukce pro makléře).
- Soft data použij nenápadně (háček), nikdy jako checklist.
- U prodávajících respektuj emoce; u kupujících sniž strach z rozhodnutí.
- Zachovej smysluplné existující triggery, přepiš robotické suggestedMessage.
- Žádný markdown, jen JSON pole.`.trim();
}

/** Heuristiky — detekce robotického tónu (pro selftest / post-check). */
const ROBOTIC_PHRASES = [
  /dovoluji si vás kontaktovat/i,
  /v návaznosti na naši/i,
  /tímto vám/i,
  /neváhejte (mě )?kontaktovat/i,
  /těším se na (další )?spolupráci/i,
  /váš realitní partner/i,
  /empatická zpráva/i,
  /napiš(te)? (empatickou )?sms/i,
  /jistě, rád vám pomohu/i,
  /jako ai|jako jazykový model/i,
  /zpracováno\.|informace byly zpracovány/i,
];

export function looksRoboticClientMessage(text) {
  const s = String(text || '');
  if (!s.trim()) return true;
  return ROBOTIC_PHRASES.some((re) => re.test(s));
}

export function sanitizeClientMessageOutput(raw, { channel = 'sms' } = {}) {
  let text = String(raw || '')
    .replace(/^```[\s\S]*?\n?/i, '')
    .replace(/\n?```$/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  if (channel === 'email') {
    return text.slice(0, 4000);
  }
  // SMS / WA — držet krátké
  if (text.length > 450) text = `${text.slice(0, 447).trim()}…`;
  return text;
}
