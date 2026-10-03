/**
 * Direct GeoPas endpoint matrix + expanded broker chat scenarios.
 * node scripts/smoke-geopas-endpoints.mjs
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import {
  entityByTerm,
  addressByCode,
  landByCode,
  poiByAddress,
  waterFloodByLand,
  noiseByLand,
  radonByPoint,
  wsdpLvByLand,
  searchProperty,
  getFullPropertyAnalysis,
  probeGeopasHealth,
} from '../src/services/geopas.js';
import { handleGeopasChatMessage } from '../src/services/geopasChatHandler.js';
import { isGeopasChatMessage } from '../src/lib/isGeopasChatMessage.js';
import { isRadarMarketQuery } from '../src/lib/chatIntent.js';
import { runRadarMarketBrief } from '../src/services/radarMarketChat.js';
import { AiTask } from '../src/config/aiRouting.js';
import { invokeJsonLlm } from '../src/services/llmRouter.js';
import { buildNemioChatSystemPrompt } from '../src/prompts/buildNemioChatSystemPrompt.js';
import { parseGeminiJsonText } from '../src/services/geminiChat.js';
import { enrichBrokerNextSteps } from '../src/services/brokerNextSteps.js';
import { ensureSoftDataFromMessage } from '../src/lib/extractSoftDataFromMessage.js';
import { ensureChatEventFromMessage } from '../src/lib/extractCalendarEventFromMessage.js';

const rows = [];
function log(status, name, detail = {}) {
  rows.push({ status, name, ...detail });
  const icon = status === 'ok' ? '✅' : status === 'warn' ? '⚠️' : '❌';
  console.log(`${icon} ${name}${detail.ms != null ? ` (${detail.ms}ms)` : ''}${detail.note ? ` — ${detail.note}` : ''}`);
}

async function timed(name, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { ok: true, result, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
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
        updateFields: { type: 'OBJECT' },
        event: { type: 'OBJECT' },
        nextSteps: { type: 'ARRAY', items: { type: 'OBJECT' } },
      },
    },
  });
  let parsed = parseGeminiJsonText(raw);
  if (!parsed.chatResponse?.trim()) {
    parsed.chatResponse = 'Potřebuji upřesnit.';
  }
  enrichBrokerNextSteps(parsed, { message });
  return parsed;
}

async function main() {
  console.log('\n======== A) GeoPas health ========');
  const health = await timed('probeGeopasHealth', () => probeGeopasHealth());
  if (health.ok) log('ok', 'probeGeopasHealth', { ms: health.ms, note: `wsdp=${health.result?.wsdpAccess}` });
  else log('fail', 'probeGeopasHealth', { ms: health.ms, note: health.error });

  console.log('\n======== B) Low-level endpoints (Mánesova chain) ========');
  let addressCode = null;
  let landKnId = null;
  let lat = null;
  let lng = null;

  {
    const r = await timed('entityByTerm', () => entityByTerm('Mánesova Praha'));
    if (!r.ok) log('fail', 'entityByTerm', { ms: r.ms, note: r.error });
    else {
      const list = Array.isArray(r.result) ? r.result : r.result?.results || r.result?.data || [];
      const n = list.length || (typeof r.result === 'object' ? Object.keys(r.result).length : 0);
      log(n ? 'ok' : 'warn', 'entityByTerm', { ms: r.ms, note: `items≈${n}` });
    }
  }

  {
    const r = await timed('searchProperty', () => searchProperty('Mánesova 12 Praha'));
    if (!r.ok) log('fail', 'searchProperty', { ms: r.ms, note: r.error });
    else {
      const list = Array.isArray(r.result) ? r.result : r.result?.results || [];
      const first = list[0];
      addressCode = first?.code || first?.addressCode || first?.id || null;
      log(list.length ? 'ok' : 'warn', 'searchProperty', {
        ms: r.ms,
        note: `n=${list.length} code=${addressCode || '—'} sample=${first?.label || first?.address || '—'}`,
      });
    }
  }

  if (addressCode) {
    const r = await timed('addressByCode', () => addressByCode(addressCode));
    if (!r.ok) log('fail', 'addressByCode', { ms: r.ms, note: r.error });
    else {
      landKnId = r.result?.landKnId || r.result?.land_kn_id || r.result?.parcelId || r.result?.knId || null;
      lat = r.result?.lat ?? r.result?.latitude ?? null;
      lng = r.result?.lng ?? r.result?.longitude ?? null;
      // try nested
      if (!landKnId && r.result?.land) landKnId = r.result.land.knId || r.result.land.id;
      if (!lat && r.result?.geometry) {
        lat = r.result.geometry.lat;
        lng = r.result.geometry.lng;
      }
      log('ok', 'addressByCode', {
        ms: r.ms,
        note: `keys=${Object.keys(r.result || {}).slice(0, 12).join(',')} land=${landKnId || '—'}`,
      });
    }

    const poi = await timed('poiByAddress', () => poiByAddress(addressCode));
    if (!poi.ok) log('fail', 'poiByAddress', { ms: poi.ms, note: poi.error });
    else log('ok', 'poiByAddress', { ms: poi.ms, note: `keys=${Object.keys(poi.result || {}).slice(0, 8).join(',')}` });
  } else {
    log('warn', 'addressByCode', { note: 'skipped — no addressCode' });
    log('warn', 'poiByAddress', { note: 'skipped' });
  }

  // Prefer land from full analysis
  {
    const r = await timed('getFullPropertyAnalysis', () => getFullPropertyAnalysis('Mánesova 12, Praha 2'));
    if (!r.ok) log('fail', 'getFullPropertyAnalysis', { ms: r.ms, note: r.error });
    else {
      landKnId = landKnId || r.result?.parcel?.knId || r.result?.parcel?.id || r.result?.landKnId;
      lat = lat ?? r.result?.property?.lat ?? r.result?.coords?.lat;
      lng = lng ?? r.result?.property?.lng ?? r.result?.coords?.lng;
      log('ok', 'getFullPropertyAnalysis', {
        ms: r.ms,
        note: `wsdp=${r.result?.wsdpAccess} flood=${!!r.result?.flood} amenities=${!!r.result?.amenities} land=${landKnId || '—'}`,
      });
    }
  }

  if (landKnId) {
    for (const [name, fn] of [
      ['landByCode', () => landByCode(landKnId)],
      ['waterFloodByLand', () => waterFloodByLand(landKnId)],
      ['noiseByLand', () => noiseByLand(landKnId)],
      ['wsdpLvByLand', () => wsdpLvByLand(landKnId, { test: true })],
    ]) {
      const r = await timed(name, fn);
      if (!r.ok) log('fail', name, { ms: r.ms, note: r.error });
      else {
        const empty = r.result == null || (typeof r.result === 'object' && !Object.keys(r.result).length);
        log(empty ? 'warn' : 'ok', name, {
          ms: r.ms,
          note: empty ? 'empty body' : `keys=${Object.keys(r.result || {}).slice(0, 10).join(',')}`,
        });
      }
    }
  } else {
    log('fail', 'land-dependent endpoints', { note: 'no landKnId resolved' });
  }

  if (lat != null && lng != null) {
    const r = await timed('radonByPoint', () => radonByPoint(lat, lng));
    if (!r.ok) log('fail', 'radonByPoint', { ms: r.ms, note: r.error });
    else log('ok', 'radonByPoint', { ms: r.ms, note: JSON.stringify(r.result).slice(0, 120) });
  } else {
    log('warn', 'radonByPoint', { note: 'skipped — no coords' });
  }

  console.log('\n======== C) Broker chat scenarios ========');
  const scenarios = [
    {
      name: 'cena-strategie',
      msg: 'Jak nastavit nabídkovou cenu u 3+kk v Ostravě?',
      check: (p) => Boolean(p.chatResponse?.trim()) && !/jako AI/i.test(p.chatResponse),
    },
    {
      name: 'hypoteka-ltv',
      msg: 'Klient má 20 % vlastní a chce byt za 5M — jaké LTV a na co si dát pozor?',
      check: (p) => /ltv|hypot|vlastn|splát/i.test(p.chatResponse || ''),
    },
    {
      name: 'namitka-cena',
      msg: 'Zájemce říká „to je moc drahé“ u prohlídky — co říct?',
      check: (p) => Boolean(p.chatResponse?.trim()) && (p.nextSteps || []).length >= 1,
    },
    {
      name: 'pravni-bremeno',
      msg: 'Na LV je věcné břemeno doživotního užívání — jak to vysvětlit kupujícímu?',
      check: (p) => /břemen|užív|rizik|advokát|notář/i.test(p.chatResponse || ''),
    },
    {
      name: 'crm-soft',
      msg: 'Novák má zlatého retrívra a je citlivý na cenu — ulož to.',
      ctx: '[Petr Novák | typ: Zájemce | prio: warm | tel: — | mail: — | rozpočet: — | bydliště: Ostrava | prodává: — | hledá: 3+kk | záměr: koupě]',
      check: (p) => {
        ensureSoftDataFromMessage(p, 'Novák má zlatého retrívra a je citlivý na cenu — ulož to.');
        const soft = [...(p.softData || []), ...(p.updateFields?.softData || [])].join(' ').toLowerCase();
        return p.intent === 'crm_action' && /retr|cen/i.test(soft);
      },
    },
    {
      name: 'agenda-hovor',
      msg: 'Naplánuj zítra hovor s panem Novákem v 16:00',
      check: (p) => {
        ensureChatEventFromMessage(p, 'Naplánuj zítra hovor s panem Novákem v 16:00', new Date());
        return Boolean(p.event?.title) && /16:00|16\.00/.test(String(p.event?.time || ''));
      },
    },
    {
      name: 'inzerat-rada',
      msg: 'Napiš tipy jak začít inzerát na rodinný dům se zahradou ve Frýdku',
      check: (p) => Boolean(p.chatResponse?.trim()) && !/parametr/i.test((p.chatResponse || '').slice(0, 80)),
    },
    {
      name: 'yield-investice',
      msg: 'Spočítej hrubý yield: nájem 18 000, cena 4 200 000',
      check: (p) => /5\.|5,|yield|výnos|%/i.test(p.chatResponse || ''),
    },
  ];

  for (const s of scenarios) {
    const r = await timed(s.name, () => chatCrm(s.msg, s.ctx || ''));
    if (!r.ok) log('fail', `chat:${s.name}`, { ms: r.ms, note: r.error });
    else {
      const pass = s.check(r.result);
      log(pass ? 'ok' : 'fail', `chat:${s.name}`, {
        ms: r.ms,
        note: `intent=${r.result.intent} preview=${(r.result.chatResponse || '').slice(0, 90).replace(/\n/g, ' ')}`,
      });
    }
  }

  console.log('\n======== D) GeoPas + Radar chat routing ========');
  const geoMsgs = [
    'Analyzuj Lískovec 537',
    'Analyzuj Mánesovu 12, Praha 2',
    'Zjisti LV pro parcelu 2201/1 Vinohrady',
    'Jsou záplavy u Nádražní 1 Ostrava?',
    'Jaký je radon u Korunní 1 Praha?',
  ];
  for (const msg of geoMsgs) {
    const isG = isGeopasChatMessage(msg);
    if (!isG) {
      log('fail', `route:${msg.slice(0, 40)}`, { note: 'isGeopasChatMessage=false' });
      continue;
    }
    const r = await timed(`geopasChat:${msg.slice(0, 36)}`, () => handleGeopasChatMessage({ message: msg }));
    if (!r.ok) log('fail', `geopasChat:${msg.slice(0, 36)}`, { ms: r.ms, note: r.error });
    else {
      const text = r.result?.chatResponse || '';
      const hasA = Boolean(r.result?.propertyAnalysis);
      const honest =
        /WSDP|vlastník|částečn|vybavenost|záplav|nenalezen|upřesn/i.test(text) || hasA;
      log(honest ? 'ok' : 'warn', `geopasChat:${msg.slice(0, 36)}`, {
        ms: r.ms,
        note: `analysis=${hasA} preview=${text.slice(0, 100).replace(/\n/g, ' ')}`,
      });
    }
  }

  {
    const msg = 'Jaké investiční byty jsou teď v Ostravě?';
    log(isRadarMarketQuery(msg) ? 'ok' : 'fail', 'isRadarMarketQuery', { note: msg });
    const r = await timed('radarMarketBrief', () => runRadarMarketBrief(msg));
    if (!r.ok) log('fail', 'radarMarketBrief', { ms: r.ms, note: r.error });
    else log(r.result?.brief ? 'ok' : 'warn', 'radarMarketBrief', {
      ms: r.ms,
      note: (r.result?.brief || '').slice(0, 120),
    });
  }

  const summary = {
    ok: rows.filter((r) => r.status === 'ok').length,
    warn: rows.filter((r) => r.status === 'warn').length,
    fail: rows.filter((r) => r.status === 'fail').length,
  };
  const out = {
    at: new Date().toISOString(),
    summary,
    health: health.ok ? health.result : null,
    rows,
  };
  writeFileSync('D:\\nemio-backend\\scripts\\smoke-endpoints-report.json', JSON.stringify(out, null, 2));
  console.log('\n======== SUMMARY ========');
  console.log(summary);
  console.log('Fails:');
  for (const r of rows.filter((x) => x.status === 'fail')) console.log(' -', r.name, r.note || '');
  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
