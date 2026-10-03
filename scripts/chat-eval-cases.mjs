/**
 * Baterie evaluačních otázek pro Makio Brain — export pro eval skripty.
 * domain: smalltalk | finance | tax | construction | law | negotiation | investment | geopas-knowledge | land | pricing
 */

export const CHAT_EVAL_CASES = [
  // ── Small talk ──
  { id: 'casual', domain: 'smalltalk', message: 'Ahoj, jak se máš?', expectIntent: /general_chat|clarification/i, minLen: 20, mustNot: /jako AI|jazykový model|nemohu/i },
  { id: 'dobry-den', domain: 'smalltalk', message: 'Dobrý den, dneska toho mám hodně', expectIntent: /general_chat/i, minLen: 30, mustNot: /jako AI/i },

  // ── Hypotéky & finance ──
  { id: 'hypoteka-ltv', domain: 'finance', message: 'Klient má čistý příjem 55 000 Kč, chce hypotéku na byt 4,5 mil. s LTV 85 %. Projde bonita?', expectIntent: /general_chat/i, minLen: 80, topic: /ltv|dsti|dti|splát|bonit|85|příjem/i, mustNot: /jako AI|potřebuji upřesnit lokalitu/i },
  { id: 'fixace', domain: 'finance', message: 'Má smysl fixace na 10 let nebo raději 5 let v dnešní situaci?', expectIntent: /general_chat/i, minLen: 60, topic: /fixac|sazb|refinanc|rizik/i },
  { id: 'americka-hyp', domain: 'finance', message: 'Vysvětli mi americkou hypotéku pro klienta', expectIntent: /general_chat/i, minLen: 70, topic: /americk|neúčel|úrok|ltv|rizik/i },
  { id: 'odhad-banky', domain: 'finance', message: 'Banka odhadla byt o 12 % pod kupní cenou. Co říct klientovi?', expectIntent: /general_chat/i, minLen: 70, topic: /odhad|bank|hotov|doplat|ltv/i },
  { id: 'stavebni-sporeni', domain: 'finance', message: 'Jak funguje stavební spoření s meziúvěrem u rekonstrukce?', expectIntent: /general_chat/i, minLen: 70, topic: /stavební\s+spoř|meziúvěr|fáze|čerp/i },

  // ── Daně ──
  { id: 'dan-prodej', domain: 'tax', message: 'Prodávám byt po 3 letech vlastnictví, 1 rok jsem v něm bydlel. Platím daň z příjmu?', expectIntent: /general_chat/i, minLen: 60, topic: /daň|5\s*let|2\s*rok|osvoboz|vlastnictv/i },
  { id: 'developer-dph', domain: 'tax', message: 'Developer prodává novostavbu — platí kupující DPH?', expectIntent: /general_chat/i, minLen: 60, topic: /dph|21\s*%|developer|novostavb/i },
  { id: 'dan-nemovitosti', domain: 'tax', message: 'Kdo platí daň z nemovitých věcí u pronájmu bytu?', expectIntent: /general_chat/i, minLen: 50, topic: /daň\s+z\s+nemovit|vlastník|1\.\s*1/i },

  // ── Stavařina ──
  { id: 'vlhkost', domain: 'construction', message: 'Jak poznám vzlínající vlhkost u cihlového domu z 30. let?', expectIntent: /general_chat/i, minLen: 80, topic: /vlh|kapil|omítk|sklep|sanac|měř/i, mustNot: /parcela|analyzuj katastr/i, routingExpert: true },
  { id: 'radon', domain: 'construction', message: 'Kupující se ptá na radon ve sklepě starého domu. Co mu říct?', expectIntent: /general_chat/i, minLen: 60, topic: /radon|měřen|sklep|sanac|limit/i },
  { id: 'azbest', domain: 'construction', message: 'Jak odhalit azbest ve střeše z 80. let a co říct kupujícímu?', expectIntent: /general_chat/i, minLen: 80, topic: /azbest|eternit|odborn|sanac|etiket/i, routingExpert: true },
  { id: 'trhliny', domain: 'construction', message: 'Jak poznám statickou trhlinu od kosmetické?', expectIntent: /general_chat/i, minLen: 70, topic: /statick|diagon|geolog|kosmet|3\s*mm/i },
  { id: 'panel-tepelne-mosty', domain: 'construction', message: 'Proč vznikají tepelné mosty u panelových domů a jak to řešit při prodeji?', expectIntent: /general_chat/i, minLen: 80, topic: /tepeln|most|panel|zatepl|plísn/i },
  { id: 'penb', domain: 'construction', message: 'Co znamená PENB třída G u domu z 70. let?', expectIntent: /general_chat/i, minLen: 60, topic: /penb|energet|třída|g|spotřeb|zatepl/i },
  { id: 'porotherm-ytong', domain: 'construction', message: 'Porovnej Porotherm a Ytong pro rodinný dům — co doporučíš makléři klientovi?', expectIntent: /general_chat/i, minLen: 70, topic: /porotherm|ytong|cihl|zdiv|tepeln/i },
  { id: 'cerne-stavby', domain: 'construction', message: 'Na pozemku je černá stavba. Jaké jsou rizika pro kupujícího?', expectIntent: /general_chat/i, minLen: 70, topic: /čern|kolaudac|demolic|stavební\s+povolen|rizik/i },

  // ── Právo & LV ──
  { id: 'vecerne-bremeno', domain: 'law', message: 'Co je věcné břemeno chůze a jak ovlivní prodej pozemku?', expectIntent: /general_chat/i, minLen: 60, topic: /břemeno|průchod|lv|hodnot|kupuj/i },
  { id: 'exekuce-lv', domain: 'law', message: 'Na LV je exekuce. Může se nemovitost prodat?', expectIntent: /general_chat/i, minLen: 70, topic: /exekuc|zástav|vymaz|kupuj|rizik/i },
  { id: 'sjm-rozvod', domain: 'law', message: 'Manželé prodávají dům ve SJM, ale manželka nechce podepsat. Co s tím?', expectIntent: /general_chat/i, minLen: 80, topic: /sjm|společn|souhlas|notář|podpis/i },
  { id: 'rezervacni', domain: 'law', message: 'Co musí obsahovat rezervační smlouva u bytu?', expectIntent: /general_chat/i, minLen: 60, topic: /rezerv|záloh|lhůt|sankc|kupní/i },
  { id: 'sosbk', domain: 'law', message: 'Co je SOSBK a kdy ji použít místo rovnou kupní smlouvy?', expectIntent: /general_chat/i, minLen: 60, topic: /sosbk|smlouv[aě]\s+o\s+smlouvě|budoucí|převod/i },
  { id: 'predkupni', domain: 'law', message: 'Co je předkupní právo na LV a jak ovlivní prodej?', expectIntent: /general_chat/i, minLen: 60, topic: /předkup|právo|koupit|vlastník/i },

  // ── Vyjednávání ──
  { id: 'namitka-cena', domain: 'negotiation', message: 'Majitel říká že provize je moc drahá. Co mu odpovím?', expectIntent: /general_chat/i, minLen: 50, topic: /proviz|fsbo|hodnot|služb|marketing/i },
  { id: 'anchoring', domain: 'negotiation', message: 'Jak použít anchoring při vyjednávání ceny s kupujícím?', expectIntent: /general_chat/i, minLen: 60, topic: /anchor|ukotv|vyjedn|nabídk|psycholog/i },
  { id: 'fsbo', domain: 'negotiation', message: 'Majitel chce prodávat sám bez RK. Jak argumentovat?', expectIntent: /general_chat/i, minLen: 60, topic: /fsbo|proviz|realizační|marketing|čistý/i },

  // ── Investice ──
  { id: 'investice-yield', domain: 'investment', message: 'Byt za 3,2 mil., nájem 16 000 měsíčně. Jaký je gross a net yield?', expectIntent: /general_chat/i, minLen: 50, topic: /yield|výnos|gross|net/i },
  { id: 'najemni-smlouva', domain: 'investment', message: 'Jaké jsou povinné náležitosti nájemní smlouvy u bytu?', expectIntent: /general_chat/i, minLen: 70, topic: /nájem|smlouv|předmět|nájemn|dob/i },
  { id: 'investicni-byt', domain: 'investment', message: 'Má smysl koupit investiční byt v Ostravě v roce 2026?', expectIntent: /general_chat|market_scan/i, minLen: 70, topic: /invest|výnos|yield|lokalit|rizik|ostrav/i },

  // ── GeoPas znalosti (obecně — bez konkrétní adresy) ──
  { id: 'safety-score-co-je', domain: 'geopas-knowledge', message: 'Co je Safety Score a z čeho se skládá?', expectIntent: /general_chat/i, minLen: 80, topic: /safety|40\s*%|kriminalit|35\s*%|25\s*%|vybavenost/i, routingExpert: true },
  { id: 'safety-score-45', domain: 'geopas-knowledge', message: 'Safety Score 45 — jak to vysvětlit kupujícímu?', expectIntent: /general_chat/i, minLen: 70, topic: /45|rizik|kriminalit|socio|vybavenost|ověř/i },
  { id: 'kriminalita-lokalita', domain: 'geopas-knowledge', message: 'Jak makléř interpretuje data o kriminalitě v lokalitě pro rodinu s dětmi?', expectIntent: /general_chat/i, minLen: 70, topic: /kriminalit|1000\s*obyv|rodin|školk|bezpeč/i },
  { id: 'zaplavy-q100', domain: 'geopas-knowledge', message: 'Co znamená záplavová zóna Q100 u pozemku?', expectIntent: /general_chat/i, minLen: 70, topic: /q100|100\s*let|záplav|povod|rizik/i, routingExpert: true },
  { id: 'zaplavy-stavba', domain: 'geopas-knowledge', message: 'Může se stavět dům v záplavovém území?', expectIntent: /general_chat/i, minLen: 60, topic: /záplav|stavb|územní|pojišt|omezen/i },
  { id: 'uzemni-plan', domain: 'geopas-knowledge', message: 'Co musím zkontrolovat v územním plánu před koupí stavebního pozemku?', expectIntent: /general_chat/i, minLen: 80, topic: /územní\s+plán|zastav|regulac|funkc|ploch/i, routingExpert: true },
  { id: 'hluk-nemovitost', domain: 'geopas-knowledge', message: 'Jak hodnotit hluk u nemovitosti u dálnice?', expectIntent: /general_chat/i, minLen: 70, topic: /hluk|dálnic|lden|trojsk|hodnot/i },
  { id: 'radon-lokalita', domain: 'geopas-knowledge', message: 'Jak zjistit radonový index lokality obecně?', expectIntent: /general_chat/i, minLen: 60, topic: /radon|index|map|měřen|obec/i },
  { id: 'poddolovani', domain: 'geopas-knowledge', message: 'Co znamená poddolované území pro kupujícího domu?', expectIntent: /general_chat/i, minLen: 60, topic: /poddolovan|sesuv|geolog|rizik|pojišt/i },
  { id: 'poi-rodina', domain: 'geopas-knowledge', message: 'Jak hodnotit občanskou vybavenost pro rodinu s dětmi?', expectIntent: /general_chat/i, minLen: 60, topic: /školk|mhd|zdravot|500\s*m|1\s*km/i },
  { id: 'exekuce-obec', domain: 'geopas-knowledge', message: 'Vysoký počet exekucí v obci — ovlivní to prodej bytu?', expectIntent: /general_chat/i, minLen: 60, topic: /exekuc|socio|score|obec|kupuj/i },
  { id: 'nezamestnanost', domain: 'geopas-knowledge', message: 'Jak nezaměstnanost v obci ovlivní Safety Score?', expectIntent: /general_chat/i, minLen: 50, topic: /nezaměstnan|socio|35\s*%|score/i },

  // ── Pozemky ──
  { id: 'pozemek-checklist', domain: 'land', message: 'Checklist před koupí stavebního pozemku — co makléř musí ověřit?', expectIntent: /general_chat/i, minLen: 100, topic: /územní|sít|přípoj|přístup|lv|geolog/i },
  { id: 'inzenyrske-site', domain: 'land', message: 'Pozemek nemá přípojku kanalizace — jaké jsou náklady a rizika?', expectIntent: /general_chat/i, minLen: 60, topic: /kanaliz|přípoj|čistič|náklad|metr/i },
  { id: 'pristupova-cesta', domain: 'land', message: 'Pozemek nemá přímý přístup z veřejné komunikace. Je to problém?', expectIntent: /general_chat/i, minLen: 60, topic: /břemeno|přístup|cest|průchod|lv/i },

  // ── Cenotvorba ──
  { id: 'nabidkova-cena', domain: 'pricing', message: 'Jak nastavit nabídkovou cenu 3+kk v Ostravě?', expectIntent: /general_chat/i, minLen: 60, topic: /nabídkov|realizační|kč\/m|medián|sezón/i },
  { id: 'sezonnost', domain: 'pricing', message: 'Kdy je nejlepší období pro prodej rodinného domu?', expectIntent: /general_chat/i, minLen: 50, topic: /jaro|podzim|léto|vánoce|sezón/i },

  // ── Novostavby & rekonstrukce ──
  { id: 'novostavba-developer', domain: 'construction', message: 'Klient kupuje novostavbu od developera. Na co se ptát v SOSBK a při předání?', expectIntent: /general_chat/i, minLen: 100, topic: /developer|sosbk|předán|svj|dph|kolaudac/i, mustNot: /jako AI|zpracováno/i },
  { id: 'rekonstrukce-rozsah', domain: 'construction', message: 'Byt 70 m² v paneláku — kolik stojí standardní rekonstrukce jádra a co zkontrolovat před koupí?', expectIntent: /general_chat/i, minLen: 80, topic: /jádro|kč\/m|panel|vlh|rozvod/i, mustNot: /jako AI/i },

  // ── Lidský tón chatu & zprávy klientovi ──
  { id: 'chat-human-tone', domain: 'negotiation', message: 'Jak ti jde?', expectIntent: /general_chat/i, minLen: 25, mustNot: /jistě, rád vám pomohu|jako AI|jazykový model|zpracováno|informace byly zpracovány/i },
  { id: 'sms-klientovi', domain: 'negotiation', message: 'Napiš SMS klientovi Petrovi — byl včera na prohlídce 3+kk, má retrívra, citlivý na cenu. Lidsky.', expectIntent: /general_chat/i, minLen: 60, topic: /ahoj|petr|prohlídk|retrívr|zítra|termín/i, mustNot: /dovoluji si|empatická zpráva|napište klientovi|jako AI/i },

  // ── Matematika / most ──
  { id: 'math-bridge', domain: 'pricing', message: 'Kolik je 15 % z 4 800 000?', expectIntent: /general_chat/i, minLen: 15, topic: /720|000|15\s*%/i },
];
