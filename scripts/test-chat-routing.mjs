/**
 * Rozsáhlý routing test Makio chatu (deterministický, bez LLM).
 * Spuštění: npm run test:chat:routing
 */
import { isGeneralExpertQuery, looksLikeGarbagePropertyQuery } from '../src/lib/generalExpertQuery.js';
import { looksLikeLocalityInfoQuery, extractLocalityNameFromMessage } from '../src/lib/localityInfoQuery.js';
import { isRadarMarketQuery } from '../src/lib/chatIntent.js';
import { isGeopasChatMessage } from '../src/lib/isGeopasChatMessage.js';
import {
  extractPropertyQuery,
  hasConcretePropertyTarget,
  looksLikePropertyQuestion,
} from '../src/lib/extractPropertyQuery.js';
import {
  isContextualMarketQuery,
  resolveLocalityFromChatHistory,
  referencesContextualLocality,
} from '../src/lib/chatContextLocality.js';
import { sanitizeBrokerGreeting } from '../src/lib/sanitizeBrokerGreeting.js';
import { applyIntentHelpIfNeeded, buildIntentHelp } from '../src/lib/intentHelp.js';
import { enrichBrokerNextSteps } from '../src/services/brokerNextSteps.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push({ name, detail: detail || '' });
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n══ ${title} ══`);
}

/** Pořadí routingu jako v /api/ai/chat (zjednodušeně). */
export function classifyChatRoute(message, history = []) {
  if (looksLikeLocalityInfoQuery(message)) return 'locality_info';
  if (isGeneralExpertQuery(message)) return 'general_expert';
  if (isRadarMarketQuery(message, history)) return 'radar';
  if (isGeopasChatMessage(message)) return 'geopas';
  return 'gemini_json';
}

const REPIS_HISTORY = [
  { role: 'user', text: 'zjisti mi o lokalitě řepiště' },
  {
    role: 'ai',
    text: 'Ahoj Michale, jasně, mrkneme na **Řepiště**. Klidná obec…',
    parsedData: { municipalityName: 'Řepiště', intent: 'locality_info' },
  },
];

section('1. Odborné dotazy → general_expert, NE GeoPas');

const EXPERT = [
  // Stavařina
  'jak poznám vzlínající vlhkost u cihlového domu z 30. let?',
  'jak odhalit azbest ve střeše z 80. let?',
  'proč vznikají tepelné mosty u panelových domů?',
  'má smysl tepelné čerpadlo u domu z 50. let?',
  'jak poznám statickou trhlinu od kosmetické?',
  'porovnej Porotherm a Ytong',
  'co znamená PENB třída G u domu z 70. let?',
  // Finance / investice
  'co je rozdíl mezi gross a net yield?',
  'co je LTV a jak spočítat hypotéku?',
  'jaká je daň z příjmu při prodeji po 4 letech?',
  'jak nastavit nabídkovou cenu 3+kk Ostrava?',
  'má smysl koupit investiční byt?',
  'kolik stojí 3+kk ve Frýdku?',
  'co je Safety Score?',
  // Právo
  'vysvětli věcné břemeno dožití',
  'co je SJM a jak ovlivní prodej?',
  'co musí obsahovat rezervační smlouva?',
  // Marketing / vyjednávání
  'jak použít anchoring při prohlídce?',
  'jak napsat inzerát pro rodiny s dětmi?',
];
for (const msg of EXPERT) {
  assert(`expert: ${msg.slice(0, 48)}`, classifyChatRoute(msg) === 'general_expert', classifyChatRoute(msg));
  assert(`  no geopas: ${msg.slice(0, 28)}`, !isGeopasChatMessage(msg));
  assert(`  no extract: ${msg.slice(0, 28)}`, extractPropertyQuery(msg) === null);
  assert(`  no concrete: ${msg.slice(0, 28)}`, !hasConcretePropertyTarget(msg, {}));
}

section('2. Info o lokalitě → locality_info');

const LOCALITY = [
  'zjisti mi info o lokalitě lískovec u frýdku místku',
  'co víš o lokalitě frýdlant nad ostravicí',
  'jaká je lokalita baška',
  'povídej mi o obci sedliště',
  'jak to je ve frýdku-místku?',
  'analyzuj lokalitu Lískovec',
  'je bezpečná lokalita Baška?',
  'info lískovec',
  'kde je lepší bydlet — Řepiště nebo Baška?',
];
for (const msg of LOCALITY) {
  assert(`locality: ${msg.slice(0, 48)}`, classifyChatRoute(msg) === 'locality_info', classifyChatRoute(msg));
  assert(`  no geopas: ${msg.slice(0, 28)}`, !isGeopasChatMessage(msg));
  const name = extractLocalityNameFromMessage(msg);
  assert(`  has name: ${msg.slice(0, 28)}`, Boolean(name && name.length >= 3), name || 'null');
}

section('3. Radar / trh');

const RADAR_YES = [
  'investiční byty v Ostravě',
  'co je na trhu ve Frýdku?',
  'najdi fsbo v ostravě',
  'prověř příležitosti praha',
  'Porovnej nabídky Brno',
  ['najdi nějaké pozemky v této lokalitě', REPIS_HISTORY],
];
const RADAR_NO = [
  'přidej klienta petr horák',
  'jak poznám vzlínající vlhkost u cihlového domu z 30. let?',
  'zjisti mi info o lokalitě lískovec',
  'porovnej Porotherm a Ytong',
  'má smysl koupit investiční byt?',
  'jak nastavit nabídkovou cenu 3+kk Ostrava?',
  'kolik stojí 3+kk ve Frýdku?',
];
for (const item of RADAR_YES) {
  const msg = Array.isArray(item) ? item[0] : item;
  const hist = Array.isArray(item) ? item[1] : [];
  assert(`radar YES: ${msg.slice(0, 45)}`, classifyChatRoute(msg, hist) === 'radar', classifyChatRoute(msg, hist));
}
for (const msg of RADAR_NO) {
  assert(
    `radar NO: ${msg.slice(0, 42)}`,
    classifyChatRoute(msg) !== 'radar',
    classifyChatRoute(msg),
  );
}

section('4. Kontext z historie (Řepiště)');

assert('resolve Řepiště', resolveLocalityFromChatHistory(REPIS_HISTORY) === 'Řepiště');
assert(
  'contextual market',
  isContextualMarketQuery('najdi nějaké pozemky v této lokalitě', REPIS_HISTORY),
);
assert(
  'references locality',
  referencesContextualLocality('najdi pozemky v této lokalitě'),
);

section('5. GeoPas — jen konkrétní cíle');

const GEOPAS_YES = [
  'Analyzuj Lískovec 537',
  '2201/1 Vinohrady',
  'Jsou záplavy u Nádražní 1 Ostrava?',
  'Zjisti LV pro parcelu 2201/1 Vinohrady',
  'Jaký je radon u Korunní 1 Praha?',
  'Lískovec 310',
];
for (const msg of GEOPAS_YES) {
  assert(`geopas YES: ${msg}`, classifyChatRoute(msg) === 'geopas' || hasConcretePropertyTarget(msg, {}));
  const q = extractPropertyQuery(msg);
  assert(`  extract ok: ${msg.slice(0, 30)}`, q && !looksLikeGarbagePropertyQuery(q), q || 'null');
}

section('6. GeoPas false positives (regrese)');

const GEOPAS_NO = [
  'jak poznám vzlínající vlhkost u cihlového domu z 30. let?',
  'zjisti mi info o lokalitě řepiště',
  'najdi nějaké pozemky v této lokalitě',
  'kolik stojí 3+kk ve Frýdku?',
  'jaká je daň z příjmu při prodeji po 4 letech?',
  'zkontroluj LV',
  'má smysl koupit investiční byt?',
];
for (const msg of GEOPAS_NO) {
  const hist = msg.includes('této lokalitě') ? REPIS_HISTORY : [];
  assert(`geopas NO: ${msg.slice(0, 48)}`, classifyChatRoute(msg, hist) !== 'geopas', classifyChatRoute(msg, hist));
}

section('7. Oslovení makléře (sanitize)');

assert(
  'Ahoj Makio → Michale',
  sanitizeBrokerGreeting('Ahoj Makio, jasně, mrkneme na Frýdlant.', 'Michale').startsWith(
    'Ahoj Michale',
  ),
);
assert(
  'bez jména beze změny',
  sanitizeBrokerGreeting('Jasně, mrkneme na Frýdlant.', '') === 'Jasně, mrkneme na Frýdlant.',
);

section('8. Intent help — follow-up pozemky');

{
  const help = buildIntentHelp('najdi nějaké pozemky v této lokalitě', { history: REPIS_HISTORY });
  assert('help intent market_scan', help.intent === 'market_scan');
  assert('help mentions Řepiště', /Řepiště/i.test(help.chatResponse));
  assert('help nextSteps', (help.nextSteps || []).length >= 1);
}

{
  const parsed = {
    intent: 'clarification_needed',
    chatResponse: 'Z textu to není úplně jasné…',
    nextSteps: [],
  };
  applyIntentHelpIfNeeded(parsed, 'najdi nějaké pozemky v této lokalitě', {
    history: REPIS_HISTORY,
  });
  assert('applyIntentHelp → market', parsed.intent === 'market_scan');
  assert('applyIntentHelp text', !/nejsem si jistý záměrem/i.test(parsed.chatResponse));
}

section('9. applyIntentHelpIfNeeded — import / runtime');

assert('applyIntentHelp is function', typeof applyIntentHelpIfNeeded === 'function');

section('10. nextSteps enrich');

{
  // Odborná rada bez operativní akce → 0 tlačítek (max 2 celkově)
  const p = { intent: 'general_chat', chatResponse: 'Test.', nextSteps: [] };
  enrichBrokerNextSteps(p, { message: 'Jak nastavit cenu 3+kk?', activeClientName: '' });
  assert('general nextSteps ≤ 2', (p.nextSteps || []).length <= 2);

  const crm = {
    intent: 'crm_action',
    isNewClient: true,
    targetClientName: 'Petr Horák',
    nextSteps: [],
  };
  enrichBrokerNextSteps(crm, { message: 'přidej klienta Petr Horák', activeClientName: 'Barbora' });
  assert('crm nextSteps 1–2', (crm.nextSteps || []).length >= 1 && (crm.nextSteps || []).length <= 2);
  assert(
    'crm bez cizího klienta',
    !(crm.nextSteps || []).some((s) => /Barbora/i.test(s.label || '')),
  );
}

section('11. Garbage property query filter');

assert('garbage long sentence', looksLikeGarbagePropertyQuery('jak poznám vzlínající vlhkost u domu'));
assert('ok short address', !looksLikeGarbagePropertyQuery('Lískovec 310'));
assert('garbage 3+kk extract', looksLikeGarbagePropertyQuery('kolik stojí 3') || extractPropertyQuery('kolik stojí 3+kk ve Frýdku?') === null);

section('12. CRM / agenda zůstává na Gemini');

for (const msg of ['přidej klienta petr horák', 'Naplánuj zítra hovor s Novákem v 16:00', 'ahoj', 'děkuji']) {
  assert(`crm/chat: ${msg.slice(0, 40)}`, classifyChatRoute(msg) === 'gemini_json');
}

// ─── Souhrn ───────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Výsledek: ${passed} OK, ${failed} SELHALO`);
if (failures.length) {
  console.log('\nSelhání:');
  for (const f of failures) console.log(`  • ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
}
console.log('═'.repeat(50));

process.exit(failed === 0 ? 0 : 1);
