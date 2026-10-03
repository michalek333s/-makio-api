import { resolveGeopasChatStrategy, geopasPipelineUsesGeminiWrap } from '../config/aiRouting.js';
import { isClaudeBillingError, isClaudeQuotaError } from '../lib/aiErrors.js';
import { extractPropertyQuery, resolvePropertyQuery } from '../lib/extractPropertyQuery.js';
import { runGeopasClaudeAgent } from './geopasClaudeAgent.js';
import { runPropertyAnalysis } from './runPropertyAnalysis.js';
import { buildEngagingPropertyMarkdown } from './formatPropertyNarrative.js';
import { invokeTextLlm } from './llmRouter.js';
import { canSpendClaude } from './claudeBudget.js';
import { recordClaudeSpend } from './claudeBudget.js';
import { sanitizeBrokerGreeting } from '../lib/sanitizeBrokerGreeting.js';

async function wrapBriefWithGemini(message, narrative, analysis, activeClientName, brokerFirstName = '') {
  const ownerHint =
    analysis.ownerAccess === 'none'
      ? 'Vlastník není v datech — vysvětli stručně WSDP (GeoPas/ČÚZK), ne vymýšlej jméno.'
      : analysis.ownerAccess === 'test' || analysis.isTestOwner
        ? 'WSDP běží v TEST režimu — NEUVÁDĚJ jméno vlastníka ani LV, jsou fiktivní ukázka. Vysvětli že katastr (parcela, výměra) je správně, ale vlastník vyžaduje produkční WSDP od GeoPas.'
        : '';

  const localityHint = analysis.localityProfile
    ? `Profil lokality (měkká data Makio): vibe=${analysis.localityProfile.vibe || '—'}, hluk=${analysis.localityProfile.noiseFeel || '—'}, poznámka="${analysis.localityProfile.notes || ''}". Použij to v úvodu — Safety Score z POI NEPŘEKLÁDEJ jako verdikt „průměrná lokalita“, pokud profil říká klidná vesnice.`
    : '';

  const brokerLine = brokerFirstName
    ? `Makléř v chatu: ${brokerFirstName} — oslov ho křestním jménem, NIKDY ne „Ahoj Makio“.`
    : 'Neoslovuj makléře „Makio“ — to jsi ty (asistent).';

  const systemPrompt = `
Jsi Makio AI — elitní realitní partner (technický auditor, právní stratég, komerční poradce).
${brokerLine}
Dostáváš hotový markdown report z GeoPas. Tvůj úkol:
- Zachovat všechny čísla, ceny, skóre a fakta beze změny.
- Úvod: věcně, bez „Jistě, rád pomohu“ — tón seniorního konzultanta.
- U rizik použij rámec: **Diagnóza → Řešení → Dopad** (stručně).
- Pokud report říká, že Safety Score je částečný / chybí kriminalita — to NEZAKRÝVEJ.
- Pokud je profil lokality (klidná vesnice apod.) — propoj ho s částečným skóre: skóre = vybavenost, profil = charakter místa.
- Pokud nemovitost nebyla nalezena — vysvětli co zkusit (obec + č.p. / parcela).
- Na závěr jeden krátký odstavec „Co dál“ — konkrétní krok (prohlídka, AML, WSDP, inzerát).
- Nepřidávat fiktivní vlastníka, LV ani ceny.
- Markdown: nadpisy ##, odrážky jen kde dává smysl, tabulku ocenění nechat.
- Nikdy neříkej „jako AI“.
${ownerHint}
${localityHint}
${activeClientName ? `Aktivní klient v CRM: ${activeClientName} — zmíň jen pokud to sedí k dotazu.` : ''}
`.trim();

  const userMessage = `Dotaz makléře: ${message}\n\nReport:\n${narrative}`;
  const { text, provider } = await invokeTextLlm({
    task: 'geopas_wrap',
    systemPrompt,
    userMessage,
    forceGemini: true,
  });
  return { chatResponse: sanitizeBrokerGreeting(text, brokerFirstName), wrapProvider: provider };
}

/**
 * Levná cesta: GeoPas API + volitelně krátké Gemini shrnutí (bez Claude tool-use).
 */
export async function runGeopasPipelineChat({ message, activeClientName = '', brokerFirstName = '' }) {
  const propertyQuery =
    extractPropertyQuery(message) || resolvePropertyQuery(message, { propertyQuery: '' });

  if (!propertyQuery?.trim()) {
    return {
      chatResponse:
        'Upřesněte prosím **adresu** (ulice nebo obec + číslo popisné, např. `Lískovec 537`) nebo **parcelu** (např. `2201/1 Vinohrady`). GeoPas potřebuje konkrétní lokalitu.',
      toolsUsed: ['pipeline'],
      geopasMode: 'pipeline',
      llmProvider: 'none',
    };
  }

  let analysis;
  try {
    analysis = await runPropertyAnalysis(propertyQuery);
  } catch (err) {
    const msg = String(err?.message || err || '');
    const notFound = /nenalezen|not found|no match|0 výsled|žádn/i.test(msg);
    const chatResponse = notFound
      ? `GeoPas nenašel shodu pro **${propertyQuery}**.\n\nZkuste **obec + č.p.** (např. \`Lískovec 537\`) nebo **parcelu + k.ú.** (např. \`2201/1 Vinohrady\`).`
      : `Nepodařilo se načíst katastr pro **${propertyQuery}**.\n\n${msg.slice(0, 180)}\n\nZkuste přesnější adresu nebo to zkuste za chvíli.`;
    return {
      chatResponse,
      toolsUsed: ['pipeline', 'error'],
      geopasMode: 'pipeline',
      llmProvider: 'none',
      propertyQuery,
      propertyAnalysis: {
        notFound: Boolean(notFound),
        errorCode: notFound ? 'NOT_FOUND' : 'GEOPAS_ERROR',
        query: propertyQuery,
        address: propertyQuery,
      },
    };
  }

  // Heuristika: chybí parcela/KÚ → považuj za slabý match
  if (!analysis?.ku && !analysis?.cadastre?.landNumber && !analysis?.area) {
    analysis = {
      ...analysis,
      notFound: true,
      errorCode: 'NOT_FOUND',
      query: propertyQuery,
    };
  }

  const narrative = buildEngagingPropertyMarkdown(analysis);
  const fromCache = Boolean(analysis.fromCache);

  let chatResponse;
  let llmProvider = fromCache ? 'cache' : 'template';

  if (
    !analysis.notFound &&
    geopasPipelineUsesGeminiWrap({ fromCache }) &&
    process.env.GEMINI_API_KEY
  ) {
    const wrapped = await wrapBriefWithGemini(message, narrative, analysis, activeClientName, brokerFirstName);
    chatResponse = wrapped.chatResponse;
    llmProvider = wrapped.wrapProvider;
  } else {
    chatResponse = narrative;
  }

  return {
    chatResponse,
    toolsUsed: fromCache ? ['runPropertyAnalysis', 'cache_hit'] : ['runPropertyAnalysis'],
    propertyQuery,
    propertyAnalysis: analysis,
    geopasMode: 'pipeline',
    llmProvider,
    fromCache,
  };
}

/**
 * Rozhodne pipeline vs Claude agent podle GEOPAS_CHAT_MODE a budgetu.
 */
export async function handleGeopasChatMessage({
  message,
  historyBlock = '',
  activeClientName = '',
  brokerFirstName = '',
}) {
  const budget = canSpendClaude('geopas_chat');
  const strategy = resolveGeopasChatStrategy({ budgetAllowsClaude: budget.ok });

  if (strategy.kind === 'none') {
    throw new Error(strategy.reason || 'GeoPas není k dispozici');
  }

  if (strategy.kind === 'pipeline') {
    if (strategy.fallback) {
      console.warn('[GeoPas] Claude nedostupný → pipeline:', strategy.reason);
    }
    return runGeopasPipelineChat({ message, activeClientName, brokerFirstName });
  }

  try {
    const agent = await runGeopasClaudeAgent({ message, historyBlock, activeClientName });
    recordClaudeSpend('geopas_chat');
    return {
      ...agent,
      geopasMode: 'claude_agent',
      llmProvider: 'claude',
    };
  } catch (e) {
    if (isClaudeBillingError(e) || isClaudeQuotaError(e)) {
      console.warn('[GeoPas] Claude agent selhal → pipeline:', e.message);
      const piped = await runGeopasPipelineChat({ message, activeClientName, brokerFirstName });
      return { ...piped, geopasFallback: true, geopasFallbackReason: e.message };
    }
    throw e;
  }
}
