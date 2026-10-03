/**
 * Cold-call skript k náběru z Radaru — hlas zkušeného makléře, ne chatbot.
 * Vrací { script, bulletPoints, suggestedTalkingPoints, provider, source }.
 * Bez AI klíče (nebo při chybě) heuristický draft stejného tvaru.
 */

import { parseGeminiJsonText } from './geminiChat.js';
import { AiTask, invokeJsonLlm } from './llmRouter.js';

function locOf(lead) {
  return String(lead?.locality || lead?.city || '').split(',')[0] || 'této lokalitě';
}

function layoutOf(lead) {
  return lead?.layout ? ` ${lead.layout}` : '';
}

function areaOf(lead) {
  return lead?.floorArea ? ` ${lead.floorArea} m²` : '';
}

function sourceOf(lead) {
  if (lead?.source === 'bazos') return 'na Bazoši';
  if (lead?.source === 'bezrealitky') return 'na Bezrealitky';
  if (lead?.source === 'facebook') return 'na Facebooku';
  return 'v inzerci';
}

function heuristicScript(lead) {
  const loc = locOf(lead);
  const layout = layoutOf(lead);
  const area = areaOf(lead);
  const src = sourceOf(lead);

  if (lead?.radarStatus === 'DUPLICATE_RK') {
    const agency = lead.matchedAgencyName || lead.agencyName;
    const who = agency ? ` přes ${agency}` : ' přes kancelář';
    return `Dobrý den, vidím byt${layout}${area} v ${loc} — běží už i${who}. Nevolám kvůli konkurenci. Až smlouva skončí, rád dám druhý názor na cenu. Mám 5 minut tento týden na kávu, nebo klidně online odhad?`;
  }
  if (lead?.radarStatus === 'SUSPECTED_BROKER') {
    return `Dobrý den, narazil jsem na inzerát${layout} v ${loc}. Než budeme řešit náběr, potřebuji ověřit, kdo nemovitost skutečně zastupuje. Můžeme si to ujasnit v krátkém hovoru?`;
  }

  return `Dobrý den, volám kvůli vašemu${layout}${area} ${src} v ${loc} — konkrétně tahle dispozice v téhle ulici mě zaujala.

Vím, že v inzerátu píšete „RK nevolat“. Nechci vás tlačit do smlouvy. Volám proto, že v ${loc} teď cíleně hledám přesně tuhle dispozici a umím říct reálnou cenu bez závazku.

Kdybyste měl 5 minut na kávu, nebo klidně online odhad, řeknu na rovinu, za kolik by to teď odešlo a co by stálo za úpravu inzerátu. Hodí se vám to dnes odpoledne?`;
}

function heuristicBulletPoints(lead) {
  const loc = locOf(lead);
  if (lead?.radarStatus === 'DUPLICATE_RK') {
    return [
      `Odkázat na konkrétní byt${layoutOf(lead)} v ${loc} — bez nátlaku.`,
      'Nebrat náběr teď; nabídnout second opinion až po smlouvě s RK.',
      'Zavřít 5 minutami na kávu nebo online odhadem.',
    ];
  }
  if (lead?.radarStatus === 'SUSPECTED_BROKER') {
    return [
      'Ověřit, kdo nemovitost skutečně zastupuje.',
      'Nenabízet náběr, dokud není jasný majitel.',
      'Krátký hovor, pak skončit.',
    ];
  }
  return [
    `Hook: konkrétní${layoutOf(lead)}${areaOf(lead)} ${sourceOf(lead)} v ${loc}.`,
    'Pivot: respektovat „RK nevolat“ — žádná smlouva na první hovor.',
    'Close: 5 minut na kávu, nebo online odhad ceny.',
  ];
}

function heuristicTalkingPoints(lead) {
  if (lead?.radarStatus === 'DUPLICATE_RK') {
    return [
      'Kdy končí exkluzivita / smlouva s kanceláří?',
      'Chcete druhý názor na cenu, až budete volní?',
      'Stačí 5 minut osobně, nebo online odhad.',
    ];
  }
  if (lead?.radarStatus === 'SUSPECTED_BROKER') {
    return [
      'Jste majitel, nebo inzerát dáváte za někoho?',
      'Kdo smí jednat o prohlídkách?',
      'Až to bude jasné, rád se ozvu znovu.',
    ];
  }
  return [
    'Za kolik byste byl ochoten jít dolů, pokud přijde vážný kupec?',
    'Kolik prohlídek už bylo a co lidi nejčastěji namítají?',
    'Mám 5 minut na kávu, nebo poslat online odhad ještě dnes?',
  ];
}

export function buildHeuristicColdCall(lead = {}) {
  return {
    script: String(lead?.ai?.draftMessage || '').trim() || heuristicScript(lead),
    bulletPoints: heuristicBulletPoints(lead),
    suggestedTalkingPoints: heuristicTalkingPoints(lead),
    provider: 'heuristic',
    source: 'heuristic',
    fallback: true,
  };
}

function asStringList(value, max = 6) {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, max);
}

const SYSTEM = `Jsi "Nemio", kolega realitního makléře s 20 lety praxe na českém trhu.
Nikdy neříkej, že jsi AI. Piš česky, vřele, konkrétně.

Vrať POUZE JSON (žádný markdown, žádné \`\`\`):
{
  "script": "souvislý text hovoru, 8–12 vět, max 900 znaků",
  "bulletPoints": ["3–5 krátkých odrážek co říct"],
  "suggestedTalkingPoints": ["3–5 otázek / bodů k vyjednávání"]
}

Pravidla pro script:
- Hook: začni pozdravem a odkazem na KONKRÉTNÍ inzerát (lokalita, dispozice, portál, m² když jsou).
- Pivot: pokud majitel píše „RK nevolat“ / bez kanceláře — respektuj to, žádný nátlak na smlouvu. Řekni, proč voláš TY (lokalita / kupující / reálná cena).
- Close: nabídni 5 minut na kávu NEBO online odhad. Jedna konkrétní otázka na čas.
- NEW_PRIVATE: argument proti prodeji naslepo (čas, prohlídky, cena, bezpečnost převodu) — bez nátlaku.
- DUPLICATE_RK: neber náběr teď; second opinion až po smlouvě.
- SUSPECTED_BROKER: ověř kdo zastupuje, a skonči.
- Žádné "jako AI", žádné obecné "máme databázi".`;

export async function generateRadarColdCall(lead = {}) {
  const fallback = buildHeuristicColdCall(lead);

  try {
    const { raw, provider } = await invokeJsonLlm({
      task: AiTask.RADAR,
      systemPrompt: SYSTEM,
      userMessage: JSON.stringify({
        title: lead.title,
        source: lead.source,
        locality: lead.locality,
        layout: lead.layout,
        floorArea: lead.floorArea,
        price: lead.price,
        radarStatus: lead.radarStatus || null,
        radarReasons: lead.radarReasons || [],
        matchedAgencyUrl: lead.matchedAgencyUrl || null,
        matchedAgencyName: lead.matchedAgencyName || lead.agencyName || null,
        daysOnPortal: lead.daysOnPortal,
        descriptionSnippet: String(lead.description || '').slice(0, 400),
      }),
      responseSchema: {
        type: 'object',
        properties: {
          script: { type: 'string' },
          bulletPoints: { type: 'array', items: { type: 'string' } },
          suggestedTalkingPoints: { type: 'array', items: { type: 'string' } },
        },
      },
    });
    const parsed = parseGeminiJsonText(raw);
    const script = String(parsed?.script || '').trim();
    if (script.length < 40) return fallback;
    const bulletPoints = asStringList(parsed.bulletPoints);
    const suggestedTalkingPoints = asStringList(parsed.suggestedTalkingPoints);
    return {
      script,
      bulletPoints: bulletPoints.length ? bulletPoints : fallback.bulletPoints,
      suggestedTalkingPoints: suggestedTalkingPoints.length
        ? suggestedTalkingPoints
        : fallback.suggestedTalkingPoints,
      provider,
      source: provider,
    };
  } catch {
    return fallback;
  }
}
