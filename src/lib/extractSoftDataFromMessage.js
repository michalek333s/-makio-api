/**
 * Když model neuloží softData / crm_action, vytáhni měkké poznámky z diktátu.
 */

const SOFT_PATTERNS = [
  { re: /zlat(?:ého|y|ý)?\s+retr[ií]v/iu, note: 'má zlatého retrívra', id: 'retr' },
  { re: /retr[ií]vr/iu, note: 'má psa (retrívr)', id: 'retr' },
  { re: /citliv(?:ý|á)\s+na\s+cen/iu, note: 'citlivý na cenu', id: 'price' },
  { re: /procház[íi]\s+rozvod/iu, note: 'prochází rozvodem', id: 'divorce' },
  { re: /rozvod/iu, note: 'rozvod / citlivá situace', id: 'divorce' },
  { re: /rozhoduje\s+(?:manželka|manžel|partner)/iu, note: 'rozhoduje partner/manžel(ka)', id: 'decider' },
  { re: /rychl(?:ý|y)\s+prodej/iu, note: 'potřebuje rychlý prodej', id: 'fast' },
  { re: /dět(?:i|mi)|škola/iu, note: 'rodina s dětmi / škola', id: 'kids' },
];

/**
 * @param {string} message
 * @returns {string[]}
 */
export function extractSoftDataFromMessage(message) {
  const s = String(message || '');
  const out = [];
  const usedIds = new Set();
  for (const { re, note, id } of SOFT_PATTERNS) {
    if (!re.test(s)) continue;
    if (id && usedIds.has(id)) continue;
    if (id) usedIds.add(id);
    out.push(note);
  }
  return out.slice(0, 5);
}

/**
 * Najde jméno klienta zmíněné u soft diktátu (Novák / pan Novák / petr novák).
 */
export function extractClientNameHintForSoft(message) {
  const s = String(message || '');
  // Pozn.: \b u diakritiky (má, Novák) v JS selhává — boundary jen kolem ASCII \w
  const m =
    s.match(/(?:^|[\s,.;:!?])(?:pan(?:í|em)?|klient(?:ka|a)?)\s+([\p{L}][\p{L}'-]{1,})(?=[\s,.;:!?]|$)/iu) ||
    s.match(/(?:^|[\s,.;:!?])([\p{L}][\p{L}'-]{2,})\s+(?:má|je|byl|byla|chce)(?=[\s,.;:!?]|$)/iu) ||
    s.match(/(?:^|[\s,.;:!?])([\p{L}][\p{L}'-]{2,})\s+[—\-–]/u);
  const raw = m?.[1] ? String(m[1]).trim() : '';
  if (!raw) return '';
  if (/^(má|je|byl|byla|chce|to|ten|ta|a|i|na|v|ve|u|o|z|ze|se|si)$/iu.test(raw)) return '';
  return raw.charAt(0).toLocaleUpperCase('cs') + raw.slice(1);
}

/**
 * Doplní softData + crm_action pokud LLM vynechal.
 */
export function ensureSoftDataFromMessage(parsed, message) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const found = extractSoftDataFromMessage(message);
  if (!found.length) return parsed;

  const existing = [
    ...(Array.isArray(parsed.softData) ? parsed.softData : []),
    ...(Array.isArray(parsed.updateFields?.softData) ? parsed.updateFields.softData : []),
  ]
    .map((x) => String(x || '').trim())
    .filter(Boolean);

  const merged = [...existing];
  const seen = new Set(existing.map((x) => x.toLowerCase()));
  for (const n of found) {
    if (seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    merged.push(n);
  }

  if (!merged.length) return parsed;

  parsed.intent = 'crm_action';
  parsed.softData = merged.slice(0, 8);
  parsed.updateFields = { ...(parsed.updateFields || {}), softData: merged.slice(0, 8) };

  if (!String(parsed.targetClientName || '').trim()) {
    const hint = extractClientNameHintForSoft(message);
    if (hint) parsed.targetClientName = hint;
  }

  if (!parsed.chatResponse?.trim() || /zpracov[aá]no/i.test(parsed.chatResponse)) {
    const who = parsed.targetClientName || 'klient';
    parsed.chatResponse = `Ukládám k **${who}**: ${merged.map((m) => `**${m}**`).join(', ')}.`;
  }

  return parsed;
}
