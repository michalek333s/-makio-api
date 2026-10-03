/**
 * Thorough GeoPas + chat smoke (service layer — same code as HTTP routes).
 * Run: node scripts/smoke-geopas-chat.mjs
 * Does not print secrets.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { searchProperty, getFullPropertyAnalysis, probeGeopasHealth } from '../src/services/geopas.js';
import { runPropertyAnalysis } from '../src/services/runPropertyAnalysis.js';
import { formatPropertyBrief } from '../src/services/propertyBrief.js';

const report = {
  startedAt: new Date().toISOString(),
  health: null,
  cases: [],
  chat: [],
  summary: { ok: 0, fail: 0, warn: 0 },
};

function pushCase(c) {
  report.cases.push(c);
  if (c.status === 'ok') report.summary.ok += 1;
  else if (c.status === 'warn') report.summary.warn += 1;
  else report.summary.fail += 1;
}

function summarizeAnalysis(a) {
  if (!a) return { empty: true };
  return {
    errorCode: a.errorCode || null,
    notFound: !!a.notFound,
    address: a.address || null,
    ku: a.ku || null,
    area: a.area || null,
    ownerAccess: a.ownerAccess || null,
    isTestOwner: !!a.isTestOwner,
    ownerShown: Boolean(a.owner && a.owner !== '—' && !String(a.owner).includes('WSDP')),
    lv: a.lv || null,
    flood: a.risks?.flood || null,
    safetyMode: a.safetyScore?.mode || null,
    safetyScore: a.safetyScore?.score ?? null,
    safetyPartial: !!(a.safetyScore?.isPartial || a.safetyScore?.mode === 'amenities_only'),
    dataQualityOverall: a.dataQuality?.overall || null,
    schools: a.amenities?.schools?.length ?? 0,
    transit: a.amenities?.transit?.length ?? 0,
    valuation: a.valuation?.realistic || null,
    valuationNotePartial: String(a.valuation?.note || '').includes('částečný') || String(a.valuation?.note || '').includes('vybavenost'),
    fromCache: !!a.fromCache,
    briefPreview: formatPropertyBrief(a).slice(0, 280),
  };
}

async function caseAnalyze(label, query, opts = {}) {
  const t0 = Date.now();
  try {
    const result = await runPropertyAnalysis(query, { useCache: true, refresh: !!opts.refresh });
    const s = summarizeAnalysis(result);
    const issues = [];
    if (s.notFound || s.errorCode === 'NOT_FOUND') issues.push('not_found');
    if (s.errorCode && s.errorCode !== 'NOT_FOUND') issues.push(`error:${s.errorCode}`);
    if (s.ownerAccess === 'none' || s.ownerAccess === 'test') issues.push(`wsdp:${s.ownerAccess}`);
    if (s.safetyPartial) issues.push(`safety:${s.safetyMode || 'partial'}`);
    if (s.ownerShown && (s.ownerAccess === 'test' || s.isTestOwner)) issues.push('BUG:test_owner_leaked');
    if (s.safetyMode === 'amenities_only' && !s.valuationNotePartial && s.valuation) {
      issues.push('WARN:valuation_may_use_partial_score');
    }
    const status = issues.some((i) => i.startsWith('BUG'))
      ? 'fail'
      : s.notFound || (s.errorCode && s.errorCode !== 'NOT_FOUND')
        ? 'fail'
        : issues.length
          ? 'warn'
          : 'ok';
    pushCase({
      label,
      query,
      ms: Date.now() - t0,
      status,
      issues,
      summary: s,
    });
  } catch (e) {
    pushCase({
      label,
      query,
      ms: Date.now() - t0,
      status: 'fail',
      issues: [`throw:${e.message}`],
      summary: null,
    });
  }
}

async function caseSearch(label, q) {
  const t0 = Date.now();
  try {
    const results = await searchProperty(q);
    const n = Array.isArray(results) ? results.length : results?.results?.length ?? 0;
    const list = Array.isArray(results) ? results : results?.results || [];
    pushCase({
      label,
      query: q,
      ms: Date.now() - t0,
      status: n > 0 ? 'ok' : 'warn',
      issues: n > 0 ? [] : ['empty_search'],
      summary: {
        count: n,
        sample: list.slice(0, 3).map((r) => r.label || r.address || r.name || r.code || JSON.stringify(r).slice(0, 80)),
      },
    });
  } catch (e) {
    pushCase({
      label,
      query: q,
      ms: Date.now() - t0,
      status: 'fail',
      issues: [`throw:${e.message}`],
      summary: null,
    });
  }
}

async function caseFullRaw(label, query) {
  const t0 = Date.now();
  try {
    const raw = await getFullPropertyAnalysis(query, { useCache: true });
    pushCase({
      label,
      query,
      ms: Date.now() - t0,
      status: raw ? 'ok' : 'fail',
      issues: raw ? [] : ['empty_raw'],
      summary: {
        hasParcel: !!raw?.parcel,
        hasFlood: !!raw?.flood,
        hasAmenities: !!raw?.amenities,
        wsdpAccess: raw?.wsdpAccess || null,
        keys: raw ? Object.keys(raw) : [],
      },
    });
  } catch (e) {
    pushCase({
      label,
      query,
      ms: Date.now() - t0,
      status: 'fail',
      issues: [`throw:${e.message}`],
      summary: null,
    });
  }
}

/** Minimal chat via same Gemini path as /api/ai/chat — import dynamically if available */
async function caseChat(label, message) {
  const t0 = Date.now();
  try {
    const { default: fetch } = await import('node:http').then(() => ({ default: globalThis.fetch }));
    // Prefer in-process: call Gemini helper through ai route is hard; use health services + direct analyze for geopas intents
    const wantsGeopas = /\b(katastr|parcela|lv|vlastník|záplav|analyzuj|mánesov|vinohrad|ostrava)\b/i.test(message);
    if (wantsGeopas) {
      const m = message.match(/(?:analyzuj|parcela|pro)\s+(.+)$/i);
      const q = m ? m[1].trim() : message;
      const result = await runPropertyAnalysis(q.replace(/^.*?parcela\s+/i, '').trim() || q);
      const brief = formatPropertyBrief(result);
      const ok = brief && !result?.notFound;
      report.chat.push({
        label,
        message,
        ms: Date.now() - t0,
        status: ok ? 'ok' : 'warn',
        path: 'geopas-pipeline-brief',
        preview: brief.slice(0, 220),
        issues: result?.ownerAccess === 'none' || result?.ownerAccess === 'test' ? [`wsdp:${result.ownerAccess}`] : [],
      });
      if (ok) report.summary.ok += 1;
      else report.summary.warn += 1;
      return;
    }
    report.chat.push({
      label,
      message,
      ms: Date.now() - t0,
      status: 'skip',
      path: 'needs-http-jwt',
      preview: 'Chat Gemini vyžaduje HTTP + JWT — viz druhá fáze',
      issues: ['needs_auth_http'],
    });
    report.summary.warn += 1;
  } catch (e) {
    report.chat.push({
      label,
      message,
      ms: Date.now() - t0,
      status: 'fail',
      issues: [e.message],
    });
    report.summary.fail += 1;
  }
}

async function main() {
  console.log('=== GeoPas health ===');
  try {
    report.health = await probeGeopasHealth();
    console.log(JSON.stringify(report.health, null, 2));
  } catch (e) {
    report.health = { error: e.message };
    console.error('health fail', e.message);
  }

  console.log('\n=== Search ===');
  await caseSearch('search-vinohrady', 'Vinohrady Praha');
  await caseSearch('search-ostrava', 'Ostrava Poruba');
  await caseSearch('search-short', 'ab');
  await caseSearch('search-parcel-like', '2201/1');

  console.log('\n=== Analyze (many) ===');
  const queries = [
    ['addr-manesova', 'Mánesova 12, Praha 2'],
    ['addr-vinohrady', 'Korunní 1, Praha Vinohrady'],
    ['addr-ostrava', 'Nádražní 1, Ostrava'],
    ['addr-brno', 'Masarykova 1, Brno'],
    ['parcel-vinohrady', '2201/1 Vinohrady'],
    ['parcel-slash', '123/1 Praha'],
    ['bad- gibberish', 'asdfghjklqwerty 99999'],
    ['obec-only', 'Frýdek-Místek'],
    ['cp-style', 'Praha 2 č.p. 12'],
  ];
  for (const [label, q] of queries) {
    console.log('analyze', label, q);
    await caseAnalyze(label, q);
  }

  console.log('\n=== Raw full analysis ===');
  await caseFullRaw('raw-manesova', 'Mánesova 12, Praha 2');
  await caseFullRaw('raw-parcel', '2201/1 Vinohrady');

  console.log('\n=== Chat-like geopas intents ===');
  await caseChat('chat-analyze-addr', 'Analyzuj Mánesovu 12, Praha 2');
  await caseChat('chat-lv-parcel', 'Zjisti LV pro parcelu 2201/1 Vinohrady');
  await caseChat('chat-flood', 'Jsou záplavy u Korunní 1 Praha Vinohrady?');

  report.finishedAt = new Date().toISOString();
  const out = 'D:\\nemio-backend\\scripts\\smoke-geopas-chat-report.json';
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log('\n=== SUMMARY ===');
  console.log(report.summary);
  console.log('Wrote', out);
  const fails = report.cases.filter((c) => c.status === 'fail');
  const warns = report.cases.filter((c) => c.status === 'warn');
  console.log('FAILS', fails.length);
  for (const f of fails) console.log('-', f.label, f.issues?.join(', '), f.query);
  console.log('WARNS', warns.length);
  for (const w of warns.slice(0, 20)) console.log('-', w.label, w.issues?.join(', '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
