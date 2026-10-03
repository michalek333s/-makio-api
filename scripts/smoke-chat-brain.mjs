/**
 * Smoke test Makio Brain chat (bez JWT — volá služby přímo).
 * Spuštění: node scripts/smoke-chat-brain.mjs
 */
import '../src/loadEnv.js';
import { enrichBrokerNextSteps } from '../src/services/brokerNextSteps.js';
import { eventDateLabelToIso } from '../src/lib/eventDates.js';
import { ensureChatEventFromMessage } from '../src/lib/extractCalendarEventFromMessage.js';
import { ensureSoftDataFromMessage } from '../src/lib/extractSoftDataFromMessage.js';
import { AiTask } from '../src/config/aiRouting.js';
import { invokeJsonLlm } from '../src/services/llmRouter.js';
import { buildNemioChatSystemPrompt } from '../src/prompts/buildNemioChatSystemPrompt.js';
import { parseGeminiJsonText } from '../src/services/geminiChat.js';
import { handleGeopasChatMessage } from '../src/services/geopasChatHandler.js';
import { isGeneralExpertQuery } from '../src/lib/generalExpertQuery.js';
import { isGeopasChatMessage } from '../src/lib/isGeopasChatMessage.js';
import { looksLikeLocalityInfoQuery } from '../src/lib/localityInfoQuery.js';
import { handleLocalityInfoChat } from '../src/services/localityInfoChat.js';
import { isRadarMarketQuery } from '../src/lib/chatIntent.js';
import { runRadarMarketBrief } from '../src/services/radarMarketChat.js';

function ok(label, cond, detail = '') {
  const pass = Boolean(cond);
  console.log(`${pass ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

async function chatCrm(message, clientsContext = '') {
  const now = new Date();
  const systemPrompt = await buildNemioChatSystemPrompt({
    currentDate: now.toLocaleDateString('cs-CZ'),
    currentTime: now.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }),
    referenceDateIso: now.toISOString().slice(0, 10),
    clientsContext: clientsContext || 'Žádní klienti',
    historyBlock: '',
    activeClientName: '',
    marketContext: '',
  });
  const { raw } = await invokeJsonLlm({
    task: AiTask.CHAT_CRM,
    systemPrompt,
    userMessage: message,
    responseSchema: {
      type: 'OBJECT',
      properties: {
        intent: { type: 'STRING' },
        chatResponse: { type: 'STRING' },
        targetClientName: { type: 'STRING' },
        softData: { type: 'ARRAY', items: { type: 'STRING' } },
        updateFields: {
          type: 'OBJECT',
          properties: {
            softData: { type: 'ARRAY', items: { type: 'STRING' } },
            phone: { type: 'STRING' },
          },
        },
        event: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' },
            type: { type: 'STRING' },
            date: { type: 'STRING' },
            dateIso: { type: 'STRING' },
            time: { type: 'STRING' },
          },
        },
        nextSteps: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              label: { type: 'STRING' },
              actionType: { type: 'STRING' },
              suggestedMessage: { type: 'STRING' },
            },
          },
        },
      },
    },
  });
  let parsed;
  try {
    parsed = parseGeminiJsonText(raw);
  } catch (e) {
    console.warn('parse fail, raw len', String(raw || '').length, e.message);
    throw e;
  }
  // Stejný safety net jako /api/ai/chat
  if (!parsed.chatResponse?.trim() && /cen[auy]|nabídkov|strategi/i.test(message)) {
    parsed.chatResponse =
      'Z praxe: **nabídková cena** bývá o **5–12 %** nad realizační. Srovnejte Kč/m² v lokalitě a zvolíte cíl (rychlý prodej vs. max výnos).';
    parsed.intent = 'general_chat';
  }
  if (!parsed.chatResponse?.trim()) {
    parsed.chatResponse = 'Potřebuji upřesnit — lokalita, adresa nebo jméno klienta.';
  }
  return parsed;
}

let failed = 0;

console.log('\n=== 1) Obecná rada (cena 3+kk Ostrava) ===');
try {
  const p = await chatCrm('Jak nastavit nabídkovou cenu u 3+kk v Ostravě?');
  enrichBrokerNextSteps(p, { message: 'Jak nastavit nabídkovou cenu u 3+kk v Ostravě?' });
  if (
    !ok('intent general/market', /general_chat|market_scan/i.test(p.intent || ''), p.intent) ||
    !ok('má chatResponse', Boolean(p.chatResponse?.trim()), (p.chatResponse || '').slice(0, 80)) ||
    !ok('má **bold**', /\*\*.+\*\*/.test(p.chatResponse || '')) ||
    !ok('nextSteps ≤ 2', (p.nextSteps || []).length <= 2, String((p.nextSteps || []).length)) ||
    !ok('neříká jako AI', !/jako AI|jazykový model/i.test(p.chatResponse || ''))
  ) {
    failed += 1;
  }
} catch (e) {
  console.log('❌ CRM chat selhal:', e.message);
  failed += 1;
}

console.log('\n=== 2) Soft data CRM ===');
try {
  const msg = 'Novák má zlatého retrívra a je citlivý na cenu — ulož to.';
  const p = await chatCrm(
    msg,
    '[Petr Novák | typ: Zájemce | prio: warm | tel: — | mail: — | rozpočet: — | bydliště: Ostrava | prodává: — | hledá: 3+kk | záměr: koupě]',
  );
  ensureSoftDataFromMessage(p, msg);
  const soft = [
    ...(Array.isArray(p.softData) ? p.softData : []),
    ...(Array.isArray(p.updateFields?.softData) ? p.updateFields.softData : []),
  ].join(' ').toLowerCase();
  if (
    !ok('crm_action', p.intent === 'crm_action', p.intent) ||
    !ok('target Novák', /novák/i.test(p.targetClientName || ''), p.targetClientName) ||
    !ok('softData zmínka', /retr|cen/i.test(soft), soft.slice(0, 120))
  ) {
    failed += 1;
  }
} catch (e) {
  console.log('❌ Soft data selhalo:', e.message);
  failed += 1;
}

console.log('\n=== 3) GeoPas katastr ===');
try {
  const msg = 'Analyzuj Lískovec 537';
  ok('isGeopasChatMessage', isGeopasChatMessage(msg));
  const geopas = await handleGeopasChatMessage({ message: msg });
  const text = geopas.chatResponse || '';
  if (
    !ok('má odpověď', Boolean(text.trim()), text.slice(0, 100)) ||
    !ok(
      'analýza nebo not-found',
      Boolean(geopas.propertyAnalysis) || /nenalezen|upřesněte|č\.p/i.test(text),
      geopas.propertyAnalysis?.ku || geopas.propertyAnalysis?.errorCode || 'text-only',
    )
  ) {
    failed += 1;
  } else if (geopas.propertyAnalysis && !geopas.propertyAnalysis.notFound) {
    const partial =
      geopas.propertyAnalysis.dataQuality?.fields?.safetyScore?.status === 'partial' ||
      /částečn/i.test(text);
    ok('partial score přiznán (info)', true, partial ? 'ano v textu/DQ' : 'DQ/live — OK i bez');
  }
} catch (e) {
  console.log('❌ GeoPas selhal:', e.message);
  failed += 1;
}

console.log('\n=== 4) Radar market ===');
try {
  const msg = 'Jaké investiční byty jsou teď v Ostravě?';
  ok('isRadarMarketQuery', isRadarMarketQuery(msg));
  const radar = await runRadarMarketBrief(msg);
  if (!ok('radar brief', Boolean(radar?.brief?.trim()), (radar?.brief || '').slice(0, 80))) {
    failed += 1;
  }
} catch (e) {
  console.log('❌ Radar selhal:', e.message);
  failed += 1;
}

console.log('\n=== 5) Agenda event ===');
try {
  const msg = 'Naplánuj zítra hovor s panem Novákem v 16:00';
  const p = await chatCrm(msg);
  ensureChatEventFromMessage(p, msg, new Date());
  const ev = p.event || {};
  const hasEvent = Boolean(ev.title && String(ev.title).trim());
  const timeOk = /16:00|16\.00/.test(String(ev.time || ''));
  if (
    !ok('crm_action', p.intent === 'crm_action', p.intent) ||
    !ok('event.title', hasEvent, ev.title) ||
    !ok('čas 16:00', timeOk, ev.time)
  ) {
    failed += 1;
  }
  if (hasEvent && ev.dateIso) {
    ok('dateIso YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(ev.dateIso), ev.dateIso);
  } else if (hasEvent) {
    const iso = eventDateLabelToIso(ev.date || 'Zítra', new Date());
    ok('dateIso fallback', Boolean(iso), iso);
  }
} catch (e) {
  console.log('❌ Agenda selhala:', e.message);
  failed += 1;
}

console.log('\n=== 6) Odborný dotaz (vlhkost) — NE GeoPas ===');
try {
  const msg = 'jak poznám vzlínající vlhkost u cihlového domu z 30. let?';
  ok('isGeneralExpertQuery', isGeneralExpertQuery(msg));
  ok('NOT isGeopasChatMessage', !isGeopasChatMessage(msg));
  const p = await chatCrm(msg);
  enrichBrokerNextSteps(p, { message: msg });
  if (
    !ok('intent general', /general_chat|clarification/i.test(p.intent || ''), p.intent) ||
    !ok('má chatResponse', Boolean(p.chatResponse?.trim()), (p.chatResponse || '').slice(0, 80)) ||
    !ok('téma vlhkost', /vlh|kapil|měř|omítk|sklep|sanac/i.test(p.chatResponse || '')) ||
    !ok('ne GeoPas parcela', !/parcela|LV|katastr/i.test((p.chatResponse || '').slice(0, 200)))
  ) {
    failed += 1;
  }
} catch (e) {
  console.log('❌ Expert dotaz selhal:', e.message);
  failed += 1;
}

console.log('\n=== 7) Info o lokalitě (Lískovec) ===');
try {
  const msg = 'zjisti mi info o lokalitě lískovec u frýdku místku';
  ok('looksLikeLocalityInfoQuery', looksLikeLocalityInfoQuery(msg));
  ok('NOT isGeopasChatMessage', !isGeopasChatMessage(msg));
  const { extractLocalityNameFromMessage } = await import('../src/lib/localityInfoQuery.js');
  const municipalityName = extractLocalityNameFromMessage(msg) || 'Lískovec';
  const loc = await handleLocalityInfoChat({ message: msg, municipalityName, brokerFirstName: 'Michale' });
  if (
    !ok('má chatResponse', Boolean(loc.chatResponse?.trim()), (loc.chatResponse || '').slice(0, 80)) ||
    !ok('lískovec v textu', /lískovec/i.test(loc.chatResponse || '')) ||
    !ok('Ahoj Michale ne Makio', !/Ahoj Makio/i.test(loc.chatResponse || '')) ||
    !ok('municipalityName', /lískovec/i.test(loc.municipalityName || municipalityName))
  ) {
    failed += 1;
  }
} catch (e) {
  console.log('❌ Locality info selhalo:', e.message);
  failed += 1;
}

console.log('\n=== 8) Kontextový radar (Řepiště z historie) ===');
try {
  const history = [
    { role: 'user', text: 'zjisti mi o lokalitě řepiště' },
    {
      role: 'ai',
      text: 'Ahoj Michale, jasně, mrkneme na **Řepiště**.',
      parsedData: { municipalityName: 'Řepiště', intent: 'locality_info' },
    },
  ];
  const msg = 'najdi nějaké pozemky v této lokalitě';
  ok('isRadarMarketQuery + history', isRadarMarketQuery(msg, history));
  const radar = await runRadarMarketBrief(msg, { history });
  const briefText = radar?.brief || radar?.chatResponse || '';
  if (
    !ok('radar brief', Boolean(briefText.trim()), briefText.slice(0, 80)) ||
    !ok('zmínka Řepiště nebo MSK', /řepiště|moravskoslezsk/i.test(briefText))
  ) {
    failed += 1;
  }
} catch (e) {
  console.log('❌ Kontextový radar selhal:', e.message);
  failed += 1;
}

console.log(`\n=== Hotovo: ${failed === 0 ? 'VŠE OK' : `${failed} scénář(e) selhaly`} ===\n`);
process.exit(failed === 0 ? 0 : 1);
