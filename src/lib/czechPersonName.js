/**
 * Normalizace českých jmen do 1. pádu + Title Case + doplnění běžné diakritiky.
 * Zrcadlí nemio-backend/src/lib/czechPersonName.js
 */

const NAME_TAIL_RE =
  /\s+(?:do\s+(?:apky|aplikace|appky|makio|crm|datab[aá]ze|db|syst[eé]mu)|pros[ií]m|d[ií]ky|děkuji)\s*$/iu;

const INVALID_NAME_TOKENS = new Set([
  'apky',
  'aplikace',
  'appky',
  'makio',
  'crm',
  'databáze',
  'databaze',
  'db',
  'systém',
  'system',
  'klienta',
  'klient',
  'klenta',
  'klent',
  'kontakt',
  'prosím',
  'prosim',
]);

/** ASCII / bez diakritiky → správný zápis (malá písmena klíče). */
const GIVEN_NAMES = {
  adam: 'Adam',
  ales: 'Aleš',
  aleš: 'Aleš',
  andrea: 'Andrea',
  aneta: 'Aneta',
  anna: 'Anna',
  antonin: 'Antonín',
  antonín: 'Antonín',
  barbora: 'Barbora',
  daniel: 'Daniel',
  david: 'David',
  denisa: 'Denisa',
  eliska: 'Eliška',
  elíška: 'Eliška',
  eva: 'Eva',
  filip: 'Filip',
  frantisek: 'František',
  františek: 'František',
  helena: 'Helena',
  ivana: 'Ivana',
  ivan: 'Ivan',
  jakub: 'Jakub',
  jan: 'Jan',
  jana: 'Jana',
  jaroslav: 'Jaroslav',
  jiri: 'Jiří',
  jiří: 'Jiří',
  josef: 'Josef',
  karel: 'Karel',
  katerina: 'Kateřina',
  kateřina: 'Kateřina',
  klara: 'Klára',
  klára: 'Klára',
  kristyna: 'Kristýna',
  kristýna: 'Kristýna',
  ladislav: 'Ladislav',
  lenka: 'Lenka',
  lucie: 'Lucie',
  lukas: 'Lukáš',
  lukáš: 'Lukáš',
  marek: 'Marek',
  marie: 'Marie',
  marketa: 'Markéta',
  markéta: 'Markéta',
  martin: 'Martin',
  martina: 'Martina',
  matej: 'Matěj',
  matěj: 'Matěj',
  michael: 'Michael',
  michal: 'Michal',
  milan: 'Milan',
  miroslav: 'Miroslav',
  monika: 'Monika',
  nikola: 'Nikola',
  ondrej: 'Ondřej',
  ondřej: 'Ondřej',
  patrik: 'Patrik',
  pavel: 'Pavel',
  pavla: 'Pavla',
  petr: 'Petr',
  petra: 'Petra',
  radek: 'Radek',
  roman: 'Roman',
  simona: 'Simona',
  stanislav: 'Stanislav',
  stepan: 'Štěpán',
  štěpán: 'Štěpán',
  tereza: 'Tereza',
  tomas: 'Tomáš',
  tomáš: 'Tomáš',
  vaclav: 'Václav',
  václav: 'Václav',
  veronika: 'Veronika',
  vladimir: 'Vladimír',
  vladimír: 'Vladimír',
  zuzana: 'Zuzana',
};

const SURNAMES = {
  benes: 'Beneš',
  beneš: 'Beneš',
  cerny: 'Černý',
  cerna: 'Černá',
  černý: 'Černý',
  černá: 'Černá',
  dvorak: 'Dvořák',
  dvorakova: 'Dvořáková',
  dvořák: 'Dvořák',
  dvořáková: 'Dvořáková',
  hapala: 'Hapala',
  horak: 'Horák',
  horakova: 'Horáková',
  horák: 'Horák',
  horáková: 'Horáková',
  kral: 'Král',
  kralova: 'Králová',
  král: 'Král',
  králová: 'Králová',
  kucera: 'Kučera',
  kucerova: 'Kučerová',
  kučera: 'Kučera',
  kučerová: 'Kučerová',
  marek: 'Marek',
  markova: 'Marková',
  marková: 'Marková',
  nemec: 'Němec',
  nemcova: 'Němcová',
  němес: 'Němec',
  němеc: 'Němec',
  němec: 'Němec',
  němcová: 'Němcová',
  novak: 'Novák',
  novakova: 'Nováková',
  novák: 'Novák',
  nováková: 'Nováková',
  novotny: 'Novotný',
  novotna: 'Novotná',
  novotný: 'Novotný',
  novotná: 'Novotná',
  novy: 'Nový',
  nova: 'Nová',
  nový: 'Nový',
  nová: 'Nová',
  ohanka: 'Oháňka',
  ohankova: 'Oháňková',
  oháňka: 'Oháňka',
  oháňková: 'Oháňková',
  pospisil: 'Pospíšil',
  pospisilova: 'Pospíšilová',
  pospíšil: 'Pospíšil',
  pospíšilová: 'Pospíšilová',
  prochazka: 'Procházka',
  prochazkova: 'Procházková',
  procházka: 'Procházka',
  procházková: 'Procházková',
  svoboda: 'Svoboda',
  svobodova: 'Svobodová',
  svobodová: 'Svobodová',
  vesely: 'Veselý',
  vesela: 'Veselá',
  veselý: 'Veselý',
  veselá: 'Veselá',
};

function foldKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

function titleCaseToken(s) {
  if (!s) return s;
  const lower = s.toLocaleLowerCase('cs-CZ');
  return lower.charAt(0).toLocaleUpperCase('cs-CZ') + lower.slice(1);
}

function normalizeToken(t, index, total) {
  if (!t || typeof t !== 'string') return t;
  let s = t.trim();
  if (!s) return s;

  // 7. pád / skloňování → nominativ (hrubá heuristika)
  if (s.length >= 4 && /ým$/iu.test(s)) {
    s = s.slice(0, -1);
  }
  if (s.length >= 6 && /ovou$/iu.test(s)) {
    s = s.replace(/ovou$/iu, 'ová');
  }
  // panem Novákem → Novák
  if (total === 1 && /\S+em$/iu.test(s) && s.length > 4) {
    s = s.replace(/em$/iu, '');
  }

  const isLikelySurname = index === total - 1 && total >= 2;

  // 4. pád mužských příjmení: Nováka / Horáka → Novák / Horák
  if (isLikelySurname && s.length >= 5 && /[aá]ka$/iu.test(s)) {
    const stem = s.slice(0, -1);
    const stemFold = foldKey(stem);
    if (SURNAMES[stemFold] || /[áa]k$/iu.test(stem)) {
      s = stem;
    }
  }

  const folded = foldKey(s);
  const dict = isLikelySurname ? SURNAMES : GIVEN_NAMES;
  // Příjmení může být i jediné slovo
  const fromDict =
    dict[folded] ||
    SURNAMES[folded] ||
    GIVEN_NAMES[folded] ||
    (folded.endsWith('ova') && SURNAMES[`${folded}`.replace(/ova$/, 'ová')]) ||
    null;

  if (fromDict) return fromDict;

  // -ova bez diakritiky → -ová
  if (/ova$/i.test(s) && !/ová$/i.test(s)) {
    return titleCaseToken(s.slice(0, -3) + 'ová');
  }

  return titleCaseToken(s);
}

/**
 * Odstraní z konce jména instrukční fráze z hlasového/chat příkazu.
 */
export function stripPersonNameTail(name) {
  if (!name || typeof name !== 'string') return name;
  let s = name.trim().replace(/[.!?,]+$/u, '');
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(NAME_TAIL_RE, '').trim();
  }
  const tokens = s.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter((t) => !INVALID_NAME_TOKENS.has(t.toLowerCase()));
  return filtered.join(' ').trim() || s;
}

/**
 * Jméno do CRM: 1. pád, Title Case, běžná česká diakritika.
 * „petr horak“ → „Petr Horák“
 */
export function normalizeCzechPersonName(name) {
  if (!name || typeof name !== 'string') return name;
  const stripped = stripPersonNameTail(name);
  const parts = stripped.split(/\s+/).filter(Boolean);
  return parts
    .map((t, i) => normalizeToken(t, i, parts.length))
    .join(' ')
    .trim();
}
