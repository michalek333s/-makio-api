/**
 * Kompletní evaluace Makio Brain — všechny obory včetně GeoPas znalostí.
 *
 * npm run eval:chat:comprehensive
 * npm run eval:chat:comprehensive -- --domain=geopas-knowledge
 * npm run eval:chat:comprehensive -- --domain=construction,finance
 * npm run eval:chat:comprehensive -- --id=vlhkost,safety-score-co-je
 */
import '../src/loadEnv.js';
import { enrichBrokerNextSteps } from '../src/services/brokerNextSteps.js';
import { AiTask } from '../src/config/aiRouting.js';
import { invokeJsonLlm } from '../src/services/llmRouter.js';
import { buildNemioChatSystemPrompt } from '../src/prompts/buildNemioChatSystemPrompt.js';
import { parseGeminiJsonText } from '../src/services/geminiChat.js';
import { isGeneralExpertQuery } from '../src/lib/generalExpertQuery.js';
import { isGeopasChatMessage } from '../src/lib/isGeopasChatMessage.js';
import { CHAT_EVAL_CASES } from './chat-eval-cases.mjs';

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING' },
    chatResponse: { type: 'STRING' },
    nextSteps: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          actionType: { type: 'STRING' },
        },
      },
    },
  },
};

function parseArgs() {
  const domains = [];
  const ids = [];
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--domain=')) {
      domains.push(...arg.slice(9).split(',').map((s) => s.trim()).filter(Boolean));
    }
    if (arg.startsWith('--id=')) {
      ids.push(...arg.slice(5).split(',').map((s) => s.trim()).filter(Boolean));
    }
  }
  return { domains, ids };
}

async function chatCrm(message, feedbackLessons = '') {
  const now = new Date();
  const systemPrompt = await buildNemioChatSystemPrompt({
    currentDate: now.toLocaleDateString('cs-CZ'),
    currentTime: now.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }),
    referenceDateIso: now.toISOString().slice(0, 10),
    clientsContext: 'Žádní klienti',
    historyBlock: '',
    activeClientName: '',
    brokerFirstName: 'Petře',
    marketContext: '',
    feedbackLessons,
  });
  const { raw } = await invokeJsonLlm({
    task: AiTask.CHAT_CRM,
    systemPrompt,
    userMessage: message,
    responseSchema: RESPONSE_SCHEMA,
  });
  const parsed = parseGeminiJsonText(raw);
  enrichBrokerNextSteps(parsed, { message });
  return parsed;
}

function ok(label, cond, detail = '') {
  const pass = Boolean(cond);
  console.log(`${pass ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

const { domains, ids } = parseArgs();
let cases = CHAT_EVAL_CASES;
if (domains.length) cases = cases.filter((c) => domains.includes(c.domain));
if (ids.length) cases = cases.filter((c) => ids.includes(c.id));

if (!cases.length) {
  console.error('Žádné testy pro zadaný filtr.');
  process.exit(1);
}

let failed = 0;
const failures = [];

console.log(`\n=== Makio Brain — comprehensive eval (${cases.length} otázek) ===\n`);

for (const c of cases) {
  console.log(`--- [${c.domain}] ${c.id}: ${c.message.slice(0, 72)}${c.message.length > 72 ? '…' : ''}`);
  try {
    if (c.routingExpert) {
      const routingOk =
        isGeneralExpertQuery(c.message) && !isGeopasChatMessage(c.message);
      if (!ok('routing expert≠geopas', routingOk)) {
        failed += 1;
        failures.push({ id: c.id, reason: 'routing' });
      }
    }
    const p = await chatCrm(c.message);
    const text = p.chatResponse || '';
    const checks = [
      ok('intent', c.expectIntent.test(p.intent || ''), p.intent),
      ok('min délka', text.length >= c.minLen, `${text.length} znaků`),
      ok('ne AI disclaimer', !/jako AI|jazykový model/i.test(text)),
      ok('nextSteps ≥ 2', (p.nextSteps || []).length >= 2, String((p.nextSteps || []).length)),
      c.topic ? ok('téma', c.topic.test(text), text.slice(0, 90)) : true,
      c.mustNot ? ok('mustNot', !c.mustNot.test(text), text.slice(0, 80)) : true,
    ];
    if (checks.some((x) => !x)) {
      failed += 1;
      failures.push({ id: c.id, reason: 'quality', preview: text.slice(0, 180) });
      console.log('   ↳ odpověď:', text.slice(0, 220).replace(/\n/g, ' '));
    }
  } catch (e) {
    console.log(`❌ CHYBA: ${e.message}`);
    failed += 1;
    failures.push({ id: c.id, reason: e.message });
  }
  console.log('');
}

console.log('=== Souhrn podle domén ===');
const byDomain = {};
for (const c of cases) {
  byDomain[c.domain] = (byDomain[c.domain] || 0) + 1;
}
for (const [d, n] of Object.entries(byDomain)) {
  const domFails = failures.filter((f) => cases.find((c) => c.id === f.id)?.domain === d).length;
  console.log(`  ${d}: ${n - domFails}/${n} OK`);
}

console.log(`\n=== Výsledek: ${failed === 0 ? 'VŠE OK' : `${failed}/${cases.length} selhalo`} ===`);
if (failures.length) {
  console.log('Selhání:', failures.map((f) => `${f.id} (${f.reason})`).join(', '));
}
process.exit(failed === 0 ? 0 : 1);
