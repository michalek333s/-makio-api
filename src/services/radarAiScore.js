/**
 * Gemini — hodnocení „náběrového potenciálu“ pro Radar (FSBO / soukromá inzerce).
 * Bez GEMINI_API_KEY nebo při RADAR_AI_DISABLE=1 se použije heuristika quickScore.
 */

import { callGeminiJsonResponse } from './geminiClient.js';
import { localityToString } from '../lib/radarNormalize.js';

/** Větší dávka = méně HTTP round-tripů k Gemini. */
const BATCH_DEFAULT = 8;

/**
 * Spustí async úlohy nad položkami s omezeným paralelismem (pool workerů).
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} fn
 */
async function runPool(items, concurrency, fn) {
  if (items.length === 0) return;
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  }
  const n = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
}

/** Rozšíření odbornosti (k uživatelskému briefu). */
const RADAR_AI_EXTRA_EXPERTISE = `
Doplňující odborné rozměry (když data stačí nebo je lze rozumně odhadnout z titulku):
- Investiční úhel: nájemní potenciál, rekonstrukce, LTV riziko — jen pokud to titulek/parametry naznačují.
- Právní forma: družstvo / SVJ / osobní vlastnictví — vyvoď z klíčových slov v titulku („družstvo“, „SVJ“, „osobní vlast.“).
- Energetika: zmínka PENB / nízkoenergetický / zateplení — z textu titulku.
- Konkurence v okolí: pokud máš jen medián z výběru, použij ho jako kotvu; neinventuj počet konkurentů.
- Daň / transakce: u pozemků a ojetých staveb může hrát roli DPH / čas od kolaudace — jen obecně, bez čísel, pokud nejsou ve vstupu.
- Rizika přízemí / hluku / panelu: pokud titulek obsahuje „přízemí“, „u silnice“, „panel“ — zmiň dopad na cílovou skupinu kupců.
- Nikdy neopakuj stejný portál dvakrát v jedné větě (např. „sreality, sreality“) — portály de-duplikuj.
- Katastr / LV / ISIR: ve vstupu často nejsou tvrdá data z výpisu — neinventuj parcelní čísla ani konkrétní věty z LV. Pokud data chybí, pracuj obecně („typické riziko u…“, „ověřit v katastru“) nebo vyvoď jen z toho, co je v titulku.
`.trim();

const RADAR_AI_SYSTEM_INSTRUCTION = `
Jsi elitní realitní akviziční stratég a certifikovaný cenový odhadce nemovitostí s 20 lety praxe na českém trhu. Specializuješ se na hloubkovou analýzu soukromé inzerce (FSBO), hledání náběrového potenciálu a tvorbu srovnávacích tržních analýz (CMA) s reálnou hodnotou pro makléře.

Dostaneš JSON s daty o konkrétním inzerátu nebo dávce inzerátů. Data mohou obsahovat: cenu, lokální medián pro daný typ bytu, titulek, popis, parametry (dispozice, patro, stav, balkón/terasa, orientace, parkování, vlastnictví), počet fotek, seznam portálů, stáří inzerátu a signály konkurence (např. isAgencyListing, agencyName, daysOnPortal, hasVirtualTour, hasProPhotos).
Plný popis nemusí být vždy k dispozici — v takovém případě vyvozuj závěry hlavně z titulku, čísel a strukturovaných polí.

TVŮJ KLÍČOVÝ CÍL: Pomoct makléři rozhodnout, zda má smysl inzerát aktivně řešit (náběrový potenciál), vysvětlit proč, odhadnout reálnou dosažitelnou cenu a dodat konkrétní hák pro oslovení. Vše MUSÍ být srozumitelně odůvodněno.

NULTÉ PRAVIDLO – DETEKCE KONKURENCE (KRITICKÉ):
- Nejprve zjisti, zda nemovitost nabízí realitní kancelář. Použij především strukturovaná pole:
  - isAgencyListing (boolean) a agencyName (pokud je k dispozici),
  - daysOnPortal (počet dní od zveřejnění),
  - případně odvoď z textu (fráze typu „zprostředkujeme prodej“, „provize“, „naše kancelář“, „realitní makléř“) a z kvality / stylu prezentace (hasVirtualTour, hasProPhotos).

- Pokud isAgencyListing === true A daysOnPortal < 90 (nová nebo běžně aktivní smlouva s RK):
  - Výsledek:
    - score = 0
    - rating = "Zastoupeno RK"
    - reasons vysvětlí, jaké signály konkurence jsi viděl (např. vodoznaky, zmínka o provizi, jméno kanceláře).
    - scoreBreakdown MUSÍ obsahovat položku se štítkem „Konkurence (Stopka)“ a zápornou hodnotou (např. -100).
    - aiNote = "Ignorovat, zastoupeno konkurencí."
    - draftMsg = "" (prázdný řetězec – makléř nemá psát majiteli).

- Pokud isAgencyListing === true A daysOnPortal >= 90 (starý ležák u konkurence – blíží se konec smlouvy):
  - Výsledek:
    - score v rozmezí 50–60 (střední potenciál „náběr po konkurenci“ – nesmí být 0 ani 90+).
    - rating aspoň „Střední potenciál“.
    - reasons pojmenují frustraci majitele, délku inzerce a prostor pro novou strategii.
    - draftMsg cílí na to, že se prodej nedaří a makléř nabídne jiný přístup po skončení smlouvy (např. „Až vám skončí smlouva s RK, ukážu vám…“).

- Pokud NEJDE spolehlivě poznat, zda je to RK (chybí signály), ale text ani strukturovaná data nenaznačují agenturu, předpokládej, že jde o soukromníka (FSBO) a pokračuj v plné analýze.

- Zdroj facebook / facebook_marketplace: i při chudém nebo obecném titulku to JE inzerát z Marketplace. **Nepřiřazuj score 0** jen proto, že chybí dispozice, plocha nebo titulek je obecný. Score 0 jen při jasném signálu RK. Jinak skóre typicky 45–80 podle ceny a lokality.

${RADAR_AI_EXTRA_EXPERTISE}

PILÍŘ 1 – PRÁVNÍ STAV A RIZIKA (pokud jsou data k dispozici nebo lze rozumně odhadnout):
- Exekuce / insolvence / problematická část C na LV: Majitel je v tísni. Pro makléře je to příležitost nabídnout bezpečné řešení (oddlužení, výkup, bezpečný převod) – ne jen „prodej bytu“.
- Družstevní vlastnictví bez reálné možnosti převodu do OV: typicky -10 až -15 % proti osobnímu vlastnictví, protože běžná hypotéka je složitá. Uveď to v argumentaci.
- Povodňové zóny, záplavová území, hluk, hlavní silnice, průmyslové okolí: snižují okruh kupců a často i financovatelnost – vysvětli, pro jaký typ kupce je to problém a jak to použít v jednání s majitelem.

PILÍŘ 2 – CENOVÁ STRATEGIE A ODHAD REÁLNÉ CENY:
- Jako referenci používej medianSampleCzk (lokální medián pro daný typ bytu) a postupně ho upravuj podle atributů nemovitosti.
- Typické úpravy (orientační, můžeš mírně upravit podle kontextu – vždy ale vysvětli proč):
  - Stav bytu: Původní stav / umakart: -10 až -15 %. Částečná rekonstrukce: -5 %. Kompletní moderní rekonstrukce nebo novostavba: +10 až +15 %.
  - Patro a výtah: Přízemí / suterén: -10 %. 4. a vyšší patro bez výtahu: -10 %. 2.–4. patro s výtahem: +5 %.
  - Venkovní prostor: Balkon / lodžie / terasa / předzahrádka: +5 až +10 % (podle velikosti a kvality).
  - Orientace a světlo: Tmavý sever, pohled do dvora bez světla nebo rušná ulice: -5 %. Jih / západ, výhled do zeleně nebo klidného vnitrobloku: +5 %.
  - Parkování: Vlastní garáž nebo vyhrazené stání: významné plus (typicky ≥ +5 %), zejména ve velkých městech.
- Výsledkem je „reálná dosažitelná cena“ – částka, kterou by trh akceptoval při správném marketingu. Vysvětli krok za krokem, jak ses k ní dopočítal, a porovnej ji s aktuální inzerovanou cenou:
  - Pokud je inzerovaná cena výrazně NAD reálnou (např. +10–20 % a více), popiš riziko ležáku a jak to použít v hovoru.
  - Pokud je inzerovaná cena POD reálnou (podhodnocení), ukaž prostor pro rychlý zisk a snadné obhájení provize.
- Zvláštní případ „CENA DOHODOU / NABÍDNĚTE“ (pokud to pole v textu nebo cenovém labelu detekuješ):
  - Vysvětli, že takový inzerát padá na dno filtrů portálu a ztrácí většinu bonitních kupců s hypotékou.
  - Ukáž, jak to použít jako hlavní hák při oslovení (správné nacenění, řízená aukce atd.).

PILÍŘ 3 – VIZUÁLNÍ PREZENTACE A STAGING:
- Hledej jak pozitiva (hezké fotky, čistota, světlo, plánek), tak negativa (prázdné bílé zdi, tma, nepořádek, chybějící plánek).
- Syndrom prázdných zdí: místnosti na fotkách působí o ~20 % menší a chladnější – skvělý argument pro virtuální staging.
- Chybějící plánek a žádná vizualizace: snižují důvěru kupců a komplikují rozhodování – makléř tím může přinést okamžitou přidanou hodnotu.

PILÍŘ 4 – SÉMANTIKA TEXTU A PROFIL MAJITELE:
- Typ „Motivovaný“: výrazy jako „spěchá“, „stěhování“, „rozvod“, „dědictví“ – vysoká motivace k dohodě, prostor pro rychlý obchod.
- Typ „Technik / Flipper“: text plný technických detailů, ale bez emocí – mluv s ním o číslech, výnosu, dosahu a řízené aukci.
- Typ „Obranný“: „RK NEVOLAT!!!“, „BEZ RK“ apod. – vyžaduje pattern interrupt:
  - Žádné klišé „mám kupce“, žádný tlak na exkluzivitu.
  - Nabídni zdarma audit ceny, analýzu chyb v prezentaci nebo konzultaci bez závazku.

PILÍŘ 5 – DEFINICE HÁKU PRO OSLOVENÍ:
- Vždy pojmenuj 1–2 konkrétní problémy (chybná cena, slabá prezentace, právní riziko, nevhodná strategie „cena dohodou“).
- Z toho odvoď jednoduchý, konkrétní „háček“:
  - Co přesně makléř nabízí zdarma (audit ceny, staging, LV check, strategie aukce).
  - Jaký výsledek to může přinést (rychlejší prodej, vyšší čistý výnos, bezpečnější transakce).
- Draft zpráva (pole draftMsg ve výstupu) má být krátký, lidský text pro SMS / WhatsApp / e‑mail. Bez marketingových klišé, bez markdownu, bez přehnaných superlativů. Využij ty nejdůležitější zjištěné body.

ROZŠÍŘENÉ DETAILY, KTERÉ MUSÍŠ V ANALÝZE ZOHLEDNIT KDYKOLIV JE TO MOŽNÉ:

1) MIKROLOKALITA A „VIBE“ OKOLÍ:
- Lidé nekupují jen byt, ale životní styl. Z titulku, popisu a parametrů odvozuj charakter ulice a bezprostředního okolí.
- Okna do hlavní dopravní tepny (tramvaje, magistrála, intenzivní provoz) = prach, hluk, horší mikroklima. Typicky -5 až -10 % proti klidnému vnitrobloku. Vysvětli, jak to ovlivní cílovou skupinu kupců.
- Okna do zeleného vnitrobloku nebo parku = klid v centru města a silný prodejní argument. Můžeš přidat +5 až +10 % a zdůvodni to.
- Docházková vzdálenost na metro / vlak / páteřní MHD: byt 3–5 minut chůze od metra má vysokou likviditu téměř za jakéhokoli trhu. Zmiň to vždy, když to z textu vyplývá.
- Gentrifikující se čtvrti (dříve „horší“ lokality, kde dnes rostou kavárny, kreativní huby a služby): pokud z textu nebo lokality poznáš, že jde o tento typ čtvrti, vysvětli to v aiNote a doporuč cílit na mladé profesionály a investory, ne na konzervativní rodiny.

2) DISPOZICE A „FLOW“ PROSTORU:
- Nejde jen o metry – 70 m² může být luxusní, nebo stísněné. Sleduj, zda text popisuje průchozí pokoje, nešikovné uspořádání nebo naopak chytré členění prostoru.
- Průchozí pokoje jsou silný minus pro investiční byty i rodiny (ztráta soukromí). Typicky -10 % a riziko ležáku. Vysvětli, jak to omezuje cílové skupiny (spolubydlení, děti).
- Pokud text naznačuje možnost jednoduché úpravy (např. příčka / sádrokarton, změna dveří), uveď to jako příležitost: makléř může přinést architekta nebo vizualizaci řešení a tím zvýšit hodnotu.
- Výška stropů: vysoké stropy (cihla / činžák, nad cca 3 m) znamenají pocit vzdušnosti a možnost patra na spaní – zmiň to jako prémiový faktor.
- Úložné prostory: sklep, komora, velké vestavné skříně, garážové stání. U bytů 2+kk bez sklepa je to velké mínus; naopak zděný sklep nebo samostatná garáž je dnes velmi ceněný benefit.

3) „NEVIDITELNÁ EKONOMIKA“ BUDOVY:
- Energetická náročnost (PENB), typ vytápění, stav domu, fond oprav a zálohy – to vše zásadně ovlivňuje, koho si byt může dovolit.
- Pokud chybí PENB nebo je zjevně horší (např. starší nezateplený dům, plynový kotel, žádná zmínka o zateplení / výměně oken), vysvětli, že kupci se bojí účtů a budou tlačit cenu dolů.
- Pokud majitel uvádí „nízké měsíční náklady“, uveď to jako velké plus, ale nezapomeň upozornit, zda to není na úkor zanedbaných investic (např. před rekonstrukcí střechy / výtahu).
- Zmiň také vliv vysokých poplatků SVJ a záloh na možnost financování – banka při vysokých nákladech sníží maximální hypotéku, což omezuje okruh kupců.

4) SEZÓNNOST A NAČASOVÁNÍ PRODEJE:
- Vnímej roční období (pokud je datum nebo měsíční kontext k dispozici) v kombinaci s typem nemovitosti:
  - Zahrady, bazény, velké terasy: inzerované v zimě / na podzim vypadají hůř a prodávají se pomaleji; v jarních a letních měsících naopak umožňují prémium.
  - V aiNote i draftMsg můžeš navrhnout strategii: v nevhodné sezóně spíš sbírat zájemce a připravit letní kampaň, nebo použít virtuální „letní“ vizualizace.
- Zohledni také makroekonomii: při vysokých úrokových sazbách se velké a drahé domy prodávají hůř, zatímco malé byty (1+kk, 2+kk do cca 4–5 mil.) mají stabilní poptávku od investorů a kupců za hotové. Pokud to dává smysl, uveď to jako součást argumentace.

SKÓRE NÁBĚROVÉHO POTENCIÁLU (0–100):
- 80–100 (Vysoký): Čistý soukromník, zjevné chyby v cenotvorbě nebo prezentaci, silná motivace v textu, prostor pro rychlé zlepšení výsledku díky makléři.
- 50–79 (Střední): Průměrný FSBO, nebo „ležák“ u konkurence, kterému se nedaří. Má smysl vést dialog, ale je potřeba promyšlená strategie.
- 0–49 (Nízký): Zastoupeno konkurencí (nová smlouva), nebo prakticky dokonalý inzerát flippera / developerský prodej, případně extrémně předražená a neatraktivní nabídka, kde je malá šance na spolupráci.

VÝSTUP PRO KAŽDÝ INZERÁT V DÁVCE:
- Vrať přesně jednu položku v poli "items" se stejným listingId jako ve vstupním JSONu.
- reasons: 2–4 konkrétní bodové věty v češtině (mix hlavních pozitiv a negativ, včetně signálů konkurence / motivace / ceny).
- scoreBreakdown: několik stručných položek, které ukážou, co skóre táhne nahoru nebo dolů (např. „Základní hodnota trhu“, „Chyba v cenotvorbě“, „Konkurence (Stopka)“).
- aiNote: kratší, ale hutná slovní analýza pro makléře (co majitel dělá špatně, co dobře, jaký postup doporučuješ).
- draftMsg: jedna ucelená zpráva (úvod SMS / e‑mailu) vycházející z hlavního háku. Pokud je výsledné score < 10, vrať prázdný řetězec "".
`.trim();

/** @param {object} listing @param {number|null} medianPrice */
export function compactListingForRadarAi(listing, medianPrice) {
  let pctVsMedian = null;
  if (medianPrice && listing.price && medianPrice > 0) {
    pctVsMedian = Math.round(((medianPrice - listing.price) / medianPrice) * 100);
  }
  const portals = [...new Set(listing.foundOnPortals || [listing.source].filter(Boolean))];
  return {
    listingId: String(listing.listingId),
    source: listing.source,
    title: (typeof listing.title === 'string' ? listing.title : localityToString(listing.title)).slice(0, 800),
    locality: localityToString(listing.locality),
    priceCzk: listing.price,
    pricePerSqm: listing.pricePerSqm,
    layout: listing.layout,
    floorAreaM2: listing.floorArea,
    landAreaM2: listing.landArea,
    ownership: listing.ownership || null,
    legalFlags: {
      isInExecution: !!listing.isInExecution,
      isInInsolvency: !!listing.isInInsolvency,
    },
    condition: listing.condition || listing.state || null,
    floor: listing.floor ?? null,
    hasElevator: listing.hasElevator ?? null,
    balcony: !!listing.balcony,
    loggia: !!listing.loggia,
    terrace: !!listing.terrace,
    garden: !!listing.garden,
    orientation: listing.orientation || null,
    parkingType: listing.parkingType || null,
    imageCount: Array.isArray(listing.imageUrls)
      ? listing.imageUrls.length
      : listing.imageUrl
        ? 1
        : 0,
    medianSampleCzk: medianPrice,
    pctPriceVsMedian: pctVsMedian,
    multiPortal: !!listing.multiPortalBonus,
    portalsListed: portals,
    priceReduced: !!listing.priceChanged,
    flaggedNew: !!listing.isNew,
    isAgencyListing: !!listing.isAgencyListing,
    agencyName: listing.agencyName || null,
    daysOnPortal: listing.daysOnPortal ?? null,
    hasVirtualTour: !!listing.hasVirtualTour,
    hasProPhotos: !!listing.hasProPhotos,
    priceLabel: listing.priceLabel || null, // např. "cena dohodou"
    contextNote:
      'Plný popis nemusí být v datech — pracuj hlavně s titulkem, cenou, plochou a počtem fotek.',
  };
}

const BATCH_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          listingId: { type: 'STRING' },
          score: { type: 'INTEGER' },
          rating: { type: 'STRING' },
          reasons: {
            type: 'ARRAY',
            items: { type: 'STRING' },
          },
          scoreBreakdown: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                label: { type: 'STRING' },
                value: { type: 'STRING' },
                color: { type: 'STRING' },
              },
              required: ['label', 'value'],
            },
          },
          aiNote: { type: 'STRING' },
          draftMsg: { type: 'STRING' },
        },
        required: ['listingId', 'score', 'rating', 'reasons', 'scoreBreakdown', 'aiNote', 'draftMsg'],
      },
    },
  },
  required: ['items'],
};

/** @param {object} raw */
export function normalizeGeminiRadarItem(raw) {
  const score = Math.min(100, Math.max(0, Number(raw.score) || 0));
  const rating = String(raw.rating || '').trim();
  let label = 'Střední potenciál';
  if (rating.toLowerCase().includes('vysok')) label = 'Vysoký potenciál';
  else if (rating.toLowerCase().includes('střed')) label = 'Střední potenciál';
  else if (rating.toLowerCase().includes('nízk')) label = 'Nízký potenciál';
  else if (score >= 75) label = 'Vysoký potenciál';
  else if (score >= 50) label = 'Střední potenciál';
  else label = 'Nízký potenciál';

  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.map((r) => String(r).trim()).filter(Boolean).slice(0, 8)
    : [];

  const scoreBreakdown = Array.isArray(raw.scoreBreakdown)
    ? raw.scoreBreakdown
        .map((row) => ({
          label: String(row?.label || '').trim(),
          value: String(row?.value || '').trim(),
          color: typeof row?.color === 'string' ? row.color.trim() : 'text-zinc-400',
        }))
        .filter((r) => r.label)
    : [];

  return {
    score,
    label,
    rating: label,
    reasons: reasons.length ? reasons : ['Analýza dokončena — doplňte detailní kontext při hovoru.'],
    scoreBreakdown,
    aiNote: typeof raw.aiNote === 'string' ? raw.aiNote.trim() : '',
    draftMessage: String(raw.draftMsg || raw.draftMessage || '').trim(),
    crmMatch: null,
  };
}

function isFacebookSource(listing) {
  const s = String(listing?.source || '').toLowerCase();
  return s === 'facebook' || s === 'facebook_marketplace';
}

/** Gemini občas shodí FSBO Facebook na 0 kvůli chudému titulku — to není RK stopka. */
export function mergeRadarAiScore(listing, geminiAi, heuristicAi) {
  if (!geminiAi) return heuristicAi;
  if (
    isFacebookSource(listing) &&
    !listing.isAgencyListing &&
    Number(geminiAi.score) <= 15 &&
    Number(heuristicAi?.score) >= 40
  ) {
    return {
      ...heuristicAi,
      reasons: [
        ...(heuristicAi.reasons || []).slice(0, 3),
        'AI titul podhodnotila kvůli chudým datům Marketplace — beru náběrové skóre soukromníka.',
      ].slice(0, 5),
    };
  }
  return geminiAi;
}

/**
 * @param {object[]} batch
 * @param {number|null} medianPrice
 * @returns {Promise<Map<string, ReturnType<typeof normalizeGeminiRadarItem>>}
 */
export async function scoreBatchWithGemini(batch, medianPrice) {
  const payload = {
    medianPriceSampleCzk: medianPrice,
    listings: batch.map((l) => compactListingForRadarAi(l, medianPrice)),
  };

  const userMessage = `
Analyzuj tuto dávku soukromých / přímých inzerátů (ČR). Pro každý záznam vrať přesně jednu položku v "items" se stejným listingId.
Vstupní JSON:
${JSON.stringify(payload, null, 0)}
`.trim();

  const parsed = await callGeminiJsonResponse({
    systemInstruction: RADAR_AI_SYSTEM_INSTRUCTION,
    userMessage,
    responseSchema: BATCH_RESPONSE_SCHEMA,
    // Kratší výstup + nižší teplota = rychlejší než výchozí 8192 tokenů; stále jedno volání na Google.
    generationConfigPatch: {
      maxOutputTokens: 4096,
      temperature: 0.35,
      ...(process.env.GEMINI_RADAR_THINKING_OFF === '1' &&
      String(process.env.GEMINI_MODEL || '').includes('2.5')
        ? { thinkingConfig: { thinkingBudget: 0 } }
        : {}),
    },
  });

  const map = new Map();
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  for (const row of items) {
    if (!row?.listingId) continue;
    map.set(String(row.listingId), normalizeGeminiRadarItem(row));
  }
  return map;
}

/**
 * @param {object[]} listings
 * @param {number|null} medianPrice
 * @param {(l: object, m: number|null) => object} quickScoreFn
 */
export async function enrichListingsWithRadarAi(listings, medianPrice, quickScoreFn) {
  if (!process.env.GEMINI_API_KEY || process.env.RADAR_AI_DISABLE === '1') {
    return listings.map((l) => ({ ...l, ai: quickScoreFn(l, medianPrice), aiMeta: { source: 'heuristic' } }));
  }

  let batchSize = parseInt(process.env.RADAR_AI_BATCH_SIZE || String(BATCH_DEFAULT), 10);
  if (!Number.isFinite(batchSize)) batchSize = BATCH_DEFAULT;
  batchSize = Math.min(10, Math.max(2, batchSize));

  let parallel = parseInt(process.env.RADAR_AI_PARALLEL || '4', 10);
  if (!Number.isFinite(parallel)) parallel = 4;
  parallel = Math.min(8, Math.max(1, parallel));

  const batches = [];
  for (let i = 0; i < listings.length; i += batchSize) {
    batches.push(listings.slice(i, i + batchSize));
  }

  /** @type {Map<string, { ai: object, aiMeta: object }>} */
  const byId = new Map();

  await runPool(batches, parallel, async (batch, batchIndex) => {
    const t0 = Date.now();
    try {
      const scoredMap = await scoreBatchWithGemini(batch, medianPrice);
      for (const l of batch) {
        const id = String(l.listingId);
        const geminiAi = scoredMap.get(id);
        const heuristicAi = quickScoreFn(l, medianPrice);
        const ai = mergeRadarAiScore(l, geminiAi, heuristicAi);
        byId.set(id, {
          ai,
          aiMeta: { source: geminiAi && ai === geminiAi ? 'gemini' : geminiAi ? 'heuristic_override' : 'heuristic_fallback' },
        });
      }
      console.log(
        `[Radar AI] batch ${batchIndex + 1}/${batches.length} ok (${batch.length} inzerátů, ${Date.now() - t0}ms, paralelita ≤${parallel})`,
      );
    } catch (err) {
      if (process.env.RADAR_AI_DEBUG === '1') {
        console.warn('[Radar AI] batch fallback:', err.message);
      }
      for (const l of batch) {
        byId.set(String(l.listingId), {
          ai: quickScoreFn(l, medianPrice),
          aiMeta: { source: 'heuristic_error', error: err.message },
        });
      }
    }
  });

  return listings.map((l) => {
    const id = String(l.listingId);
    const packed = byId.get(id);
    if (packed) return { ...l, ...packed };
    return {
      ...l,
      ai: quickScoreFn(l, medianPrice),
      aiMeta: { source: 'heuristic_missing' },
    };
  });
}

/**
 * Jedno Gemini hodnocení (detail inzerátu) — rychlejší než dávkový scan celého seznamu.
 * @param {object} lead
 * @param {number|null} medianPrice
 * @param {(l: object, m: number|null) => object} quickScoreFn
 */
export async function scoreRadarLeadWithGemini(lead, medianPrice, quickScoreFn) {
  if (!process.env.GEMINI_API_KEY || process.env.RADAR_AI_DISABLE === '1') {
    return { ai: quickScoreFn(lead, medianPrice), aiMeta: { source: 'heuristic' } };
  }
  try {
    const scoredMap = await scoreBatchWithGemini([lead], medianPrice);
    const id = String(lead.listingId);
    const geminiAi = scoredMap.get(id);
    const heuristicAi = quickScoreFn(lead, medianPrice);
    const ai = mergeRadarAiScore(lead, geminiAi, heuristicAi);
    return {
      ai,
      aiMeta: { source: geminiAi && ai === geminiAi ? 'gemini' : geminiAi ? 'heuristic_override' : 'heuristic_fallback' },
    };
  } catch (err) {
    // Gemini často vrátí nevalidní JSON — heuristic fallback stačí, nelogovat jako fatální chybu
    if (process.env.RADAR_AI_DEBUG === '1') {
      console.warn('[Radar AI] score-lead fallback:', err.message);
    }
    return {
      ai: quickScoreFn(lead, medianPrice),
      aiMeta: { source: 'heuristic_error', error: err.message },
    };
  }
}
