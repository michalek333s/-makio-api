import { normalizeCzechPersonName } from './czechPersonName.js';
import { eventDateLabelToIso, normalizeTime } from './eventDates.js';

function foldCs(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

function resolveClientName(clients, nameGuess, findCrmClientByNameMatch) {
  if (!nameGuess) return '';
  const fromFn = findCrmClientByNameMatch?.(clients, nameGuess);
  if (fromFn?.name) return fromFn.name;

  if (!Array.isArray(clients) || !clients.length) return nameGuess;
  const g = foldCs(nameGuess);
  const hit =
    clients.find((c) => foldCs(c.name) === g) ||
    clients.find((c) => {
      const cn = foldCs(c.name);
      if (cn.includes(g) || g.includes(cn)) return true;
      const parts = cn.split(/\s+/).filter(Boolean);
      return parts[parts.length - 1] === g;
    });
  return hit?.name || nameGuess;
}

/**
 * Když model vrátí general_chat bez event objektu, zkusíme z českého textu
 * vytáhnout plán (hovor/schůzka + čas + zítra/dnes + jméno).
 * Bez HH:MM defaultuje na 10:00, pokud je jasný scheduling + den.
 */
export function tryExtractCalendarFromUserMessage(
  input,
  clients,
  findCrmClientByNameMatch,
  refDate = new Date(),
) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const s = raw.replace(/\bpamenm\b/giu, 'panem');

  const scheduling =
    /(naplánuj|naplánovat|naplánujte|přidej\s+(?:do\s+)?(?:kalendář|agend|diář)|\budálost)/iu.test(s) ||
    /(hovor|schůzk|schuzk|prohlídk|prohlidk|videohovor|setkání|zvonit)/iu.test(s);
  if (!scheduling) return null;

  const hasTime = /\d{1,2}:\d{2}/.test(s);
  const hasDay = /\b(zítra|zitr|dnes|pozítří|pozítři)\b/iu.test(s);
  if (!hasTime && !hasDay && !/naplánuj/iu.test(s)) return null;

  let time = '10:00';
  const tm = s.match(/(\d{1,2}):(\d{2})/);
  if (tm) time = normalizeTime(`${tm[1]}:${tm[2]}`);

  let dateLabel = 'Zítra';
  let dateIso = eventDateLabelToIso('Zítra', refDate);
  if (/\bzítra\b|\bzitr\b/iu.test(s)) {
    dateLabel = 'Zítra';
    dateIso = eventDateLabelToIso('Zítra', refDate);
  } else if (/\bdnes\b/iu.test(s)) {
    dateLabel = 'Dnes';
    dateIso = eventDateLabelToIso('Dnes', refDate);
  } else if (/pozítří|pozítři/iu.test(s)) {
    dateLabel = 'Pozítří';
    dateIso = eventDateLabelToIso('Pozítří', refDate);
  }

  let evType = 'call';
  if (/schůzk|schuzk|prohlídk|prohlidk|setkání|setkani/iu.test(s)) evType = 'meeting';
  if (/video|zoom|teams|meet\.google/iu.test(s)) evType = 'video';

  let nameGuess = '';
  const timeOrEnd = hasTime
    ? `(?:\\s+(?:od|v|ve|na)\\s+\\d{1,2}:\\d{2}|\\s+\\d{1,2}:\\d{2})`
    : `(?:\\s*$|\\s+[—\\-]|\\s+prosím)`;
  const mPan = s.match(
    new RegExp(
      `\\b(?:s|se)\\s+(?:panem|paní|klientem|klientkou)\\s+([^\\n,]+?)${timeOrEnd}`,
      'iu',
    ),
  );
  const mHovor = s.match(
    new RegExp(`\\bhovor\\s+(?:s|se)\\s+([^\\n,]+?)${timeOrEnd}`, 'iu'),
  );
  const mLoose = s.match(new RegExp(`\\s+s\\s+([^\\n,]+?)${timeOrEnd}`, 'iu'));
  const rawName = (mPan?.[1] || mHovor?.[1] || mLoose?.[1] || '').trim();
  if (rawName) {
    let n = normalizeCzechPersonName(rawName.replace(/\s+/g, ' '));
    // 7. pád: Horákem → Horák
    if (/\S+em$/iu.test(n) && !/\s/.test(n)) {
      n = n.replace(/em$/iu, '');
    }
    nameGuess = n;
  }

  const targetClientName = resolveClientName(clients, nameGuess, findCrmClientByNameMatch);

  const title = (() => {
    const who = targetClientName || nameGuess || '';
    if (evType === 'video') return who ? `Videohovor — ${who}` : 'Videohovor';
    if (evType === 'meeting') return who ? `Schůzka — ${who}` : 'Schůzka';
    return who ? `Hovor — ${who}` : 'Hovor';
  })();

  return {
    targetClientName,
    event: {
      title,
      type: evType,
      date: dateLabel,
      dateIso,
      time,
      location: '',
      meetingUrl: '',
    },
  };
}

/**
 * Doplní event do AI payloadu, když LLM vynechal title (často u „Naplánuj zítra hovor…“).
 * @param {object} parsed
 * @param {string} message
 * @param {Date} [refDate]
 * @param {object[]} [clients]
 * @param {Function} [findCrmClientByNameMatch]
 */
export function ensureChatEventFromMessage(
  parsed,
  message,
  refDate = new Date(),
  clients = [],
  findCrmClientByNameMatch,
) {
  if (!parsed || typeof parsed !== 'object') return parsed;

  const hint = tryExtractCalendarFromUserMessage(
    message,
    clients,
    findCrmClientByNameMatch,
    refDate,
  );
  if (!hint?.event?.title) return parsed;

  const aiEv = parsed.event && typeof parsed.event === 'object' ? parsed.event : {};
  const aiEventTitleOk =
    aiEv.title && String(aiEv.title).trim() && String(aiEv.title).toLowerCase() !== 'null';
  if (aiEventTitleOk) return parsed;

  parsed.intent = 'crm_action';
  parsed.event = { ...aiEv, ...hint.event };
  if (hint.targetClientName && !String(parsed.targetClientName || '').trim()) {
    parsed.targetClientName = hint.targetClientName;
  }
  if (
    !String(parsed.chatResponse || '').trim() ||
    /zpracováno\.?\s*potřebujete/i.test(parsed.chatResponse || '')
  ) {
    parsed.chatResponse = `**${hint.event.title}** — uloženo do agendy na **${hint.event.date} v ${hint.event.time}**.`;
  }
  return parsed;
}
