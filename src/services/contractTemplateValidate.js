/**
 * Validace Word šablon před docxtemplater — spolehlivost bez „tichých“ chyb.
 * Extrakce tagů z OOXML: spojení textů <w:t> (Word často rozdělí {{ a }} do více uzlů).
 */

import PizZip from 'pizzip';
import {
  CONTRACT_CRM_KEYS,
  CONTRACT_CRM_KEY_SET,
  describeContractTag,
} from './contractCrmMap.js';

/** Spojí textové uzly w:t v jednom XML souboru (pořadí jako v souboru). */
export function joinWTextContent(xml) {
  if (!xml || typeof xml !== 'string') return '';
  const chunks = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gi)].map((m) => m[1]);
  return chunks.join('');
}

/**
 * Vytáhne jednoduché proměnné {{název}} — ignoruje docxtemplater řídicí tagy (#if, smyčky, filtry).
 */
export function extractVariableTagsFromJoinedText(joined) {
  const found = [];
  const re = /\{\{([^}]+)\}\}/g;
  let m;
  while ((m = re.exec(joined)) !== null) {
    const inner = m[1].trim();
    if (!inner) continue;
    if (inner.includes('|')) continue;
    if (/^#|\^|\/|@/.test(inner)) continue;
    const firstToken = inner.split(/\s+/)[0];
    if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(firstToken)) {
      found.push(firstToken);
    }
  }
  return [...new Set(found)];
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

export function suggestClosestKey(wrong) {
  let best = null;
  let bestD = Infinity;
  const w = String(wrong).toLowerCase();
  for (const k of CONTRACT_CRM_KEYS) {
    const d = levenshtein(w, k.toLowerCase());
    if (d < bestD && d <= 2) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

const INSPECT_XML_RE =
  /^(word\/document\.xml|word\/header\d+\.xml|word\/footer\d+\.xml|word\/footnotes\.xml|word\/endnotes\.xml)$/;

/**
 * @param {Buffer} buffer
 * @param {Record<string, string>} crmData — výstup buildFullContractRenderData
 * @returns {object}
 */
export function inspectDocxBuffer(buffer, crmData = {}) {
  const warnings = [];
  if (!buffer?.length) {
    return {
      ok: false,
      tagsFound: [],
      unknownTags: [],
      emptyCrmFields: [],
      warnings: ['Prázdný soubor.'],
      braceMismatch: true,
      hasDocument: false,
    };
  }

  let zip;
  try {
    zip = new PizZip(buffer);
  } catch (e) {
    return {
      ok: false,
      tagsFound: [],
      unknownTags: [],
      emptyCrmFields: [],
      warnings: [`Soubor nelze otevřít jako ZIP (.docx): ${e.message || e}`],
      braceMismatch: true,
      hasDocument: false,
    };
  }

  const paths = Object.keys(zip.files).filter((p) => INSPECT_XML_RE.test(p) && !zip.files[p].dir);
  const hasDocument = paths.includes('word/document.xml');
  if (!hasDocument) {
    warnings.push('Chybí word/document.xml — není to platný dokument Word (.docx).');
  }

  const allTags = new Set();
  let braceMismatch = false;

  for (const p of paths) {
    let xml;
    try {
      xml = zip.files[p].asText();
    } catch {
      continue;
    }
    const joined = joinWTextContent(xml);
    const open = (joined.match(/\{\{/g) || []).length;
    const close = (joined.match(/\}\}/g) || []).length;
    if (open !== close) {
      braceMismatch = true;
      warnings.push(
        `V části „${p}“ nejsou vyvážené závorky {{ a }} — zkontrolujte tagy nebo vložte je jako prostý text (bez formátování uprostřed).`,
      );
    }
    for (const t of extractVariableTagsFromJoinedText(joined)) {
      allTags.add(t);
    }
  }

  const tagsFound = [...allTags].sort();
  const unknownTags = tagsFound
    .filter((t) => !CONTRACT_CRM_KEY_SET.has(t))
    .map((tag) => ({
      tag,
      suggestion: suggestClosestKey(tag),
    }));

  const emptyCrmFields = tagsFound
    .filter((t) => CONTRACT_CRM_KEY_SET.has(t))
    .filter((t) => {
      const v = crmData[t];
      return v === '' || v == null;
    })
    .map((tag) => ({
      tag,
      description: describeContractTag(tag),
      label: describeContractTag(tag),
    }));

  if (tagsFound.length === 0 && hasDocument) {
    warnings.push(
      'Ve šabloně nebyly nalezeny žádné podporované tagy {{...}} — výstup bude stejný jako vstup (bez dosazení).',
    );
  }

  const ok = hasDocument && unknownTags.length === 0 && !braceMismatch;

  return {
    ok,
    tagsFound,
    unknownTags,
    emptyCrmFields,
    warnings,
    braceMismatch,
    hasDocument,
  };
}
