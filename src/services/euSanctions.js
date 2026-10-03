import { XMLParser } from 'fast-xml-parser';

const EU_SANCTIONS_XML_URL =
  process.env.EU_SANCTIONS_XML_URL ||
  'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw';
const EU_SANCTIONS_REFRESH_MS = 24 * 60 * 60 * 1000;
const SUPABASE_TIMEOUT_MS = 10_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: true,
  trimValues: true,
});

const cache = {
  loadedAt: 0,
  entries: [],
  sourceUrl: EU_SANCTIONS_XML_URL,
  lastError: null,
};

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAliasNames(entity) {
  const aliases = asArray(entity?.nameAlias);
  const names = [];
  for (const alias of aliases) {
    const whole = String(alias?.wholeName || '').trim();
    const first = String(alias?.firstName || '').trim();
    const middle = String(alias?.middleName || '').trim();
    const last = String(alias?.lastName || '').trim();
    const composed = [first, middle, last].filter(Boolean).join(' ').trim();
    if (whole) names.push(whole);
    if (composed) names.push(composed);
  }
  return [...new Set(names)];
}

function parseEntriesFromXml(xmlText) {
  const parsed = parser.parse(xmlText);
  const root = parsed?.export?.sanctionEntity || parsed?.sanctionEntity || [];
  const entities = asArray(root);

  return entities
    .map((entity) => {
      const allNames = extractAliasNames(entity);
      if (!allNames.length) return null;
      const subjectType = String(entity?.subjectType?.classificationCode || '').trim() || 'unknown';
      const listedName = allNames[0];
      return {
        euReferenceNumber: String(entity?.euReferenceNumber || '').trim(),
        logicalId: String(entity?.logicalId || '').trim(),
        regulationNumberTitle: String(entity?.regulation?.numberTitle || '').trim(),
        subjectType,
        listedName,
        aliases: allNames,
        normalizedAliases: allNames.map(normalizeText).filter(Boolean),
      };
    })
    .filter(Boolean);
}

async function saveEntriesToSupabase(entries) {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceKey || !entries.length) return;

  const payload = entries.map((entry) => ({
    source: 'eu',
    source_id: entry.euReferenceNumber || entry.logicalId || entry.listedName,
    listed_name: entry.listedName,
    aliases: entry.aliases,
    normalized_aliases: entry.normalizedAliases,
    subject_type: entry.subjectType,
    regulation_ref: entry.regulationNumberTitle || null,
    imported_at: new Date().toISOString(),
  }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
  try {
    await fetch(`${supabaseUrl}/rest/v1/eu_sanctions_cache?on_conflict=source,source_id`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncEuSanctionsCache({ force = false } = {}) {
  const now = Date.now();
  const isFresh = now - cache.loadedAt < EU_SANCTIONS_REFRESH_MS;
  if (!force && isFresh && cache.entries.length) {
    return {
      count: cache.entries.length,
      loadedAt: new Date(cache.loadedAt).toISOString(),
      source: 'memory',
      sourceUrl: cache.sourceUrl,
      skipped: true,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(EU_SANCTIONS_XML_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`EU sanctions feed unavailable (${response.status})`);
    }
    const xmlText = await response.text();
    const entries = parseEntriesFromXml(xmlText);
    if (!entries.length) {
      throw new Error('EU sanctions feed parsed with zero entities');
    }

    cache.entries = entries;
    cache.loadedAt = Date.now();
    cache.lastError = null;
    cache.sourceUrl = EU_SANCTIONS_XML_URL;

    await saveEntriesToSupabase(entries);

    return {
      count: entries.length,
      loadedAt: new Date(cache.loadedAt).toISOString(),
      source: 'download',
      sourceUrl: EU_SANCTIONS_XML_URL,
      skipped: false,
    };
  } catch (error) {
    cache.lastError = error?.message || 'Unknown EU sanctions sync error';
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function findMatchesByName(name) {
  const normalizedName = normalizeText(name);
  if (!normalizedName || !cache.entries.length) return [];

  const queryTokens = normalizedName.split(' ').filter((t) => t.length >= 3);
  if (!queryTokens.length) return [];

  const hasLongToken = queryTokens.some((t) => t.length >= 5);
  return cache.entries
    .filter((entry) => {
      return entry.normalizedAliases.some((alias) => {
        if (alias === normalizedName) return true;
        if (!hasLongToken) return false;

        const aliasTokens = alias.split(' ').filter((t) => t.length >= 3);
        if (!aliasTokens.length) return false;

        const aliasSet = new Set(aliasTokens);
        const tokenHits = queryTokens.filter((t) => aliasSet.has(t)).length;
        const requiredHits = Math.min(2, queryTokens.length);
        if (tokenHits < requiredHits) return false;

        // Require at least one distinctive token (5+ chars) to lower false positives.
        return queryTokens.some((t) => t.length >= 5 && aliasSet.has(t));
      });
    })
    .slice(0, 5);
}

export async function runEuSanctionsCheck({ name = '' } = {}) {
  const qName = String(name || '').trim();
  if (!qName) {
    return {
      passed: true,
      detail: 'EU sanctions: chybí jméno osoby/subjektu.',
      source: 'eu_sanctions',
      matches: 0,
      classification: 'unknown',
      loadedAt: cache.loadedAt ? new Date(cache.loadedAt).toISOString() : null,
    };
  }

  try {
    if (!cache.entries.length || Date.now() - cache.loadedAt >= EU_SANCTIONS_REFRESH_MS) {
      await syncEuSanctionsCache();
    }
  } catch (error) {
    return {
      passed: true,
      detail: `EU sanctions cache nedostupná: ${error?.message || 'neznámá chyba'}`,
      source: 'eu_sanctions',
      matches: 0,
      classification: 'unknown',
      loadedAt: cache.loadedAt ? new Date(cache.loadedAt).toISOString() : null,
    };
  }

  const matches = findMatchesByName(qName);
  if (!matches.length) {
    return {
      passed: true,
      detail: 'EU sanctions: bez nálezu v lokálním cache.',
      source: 'eu_sanctions',
      matches: 0,
      classification: 'clear',
      loadedAt: new Date(cache.loadedAt).toISOString(),
    };
  }

  const top = matches[0];
  return {
    passed: false,
    detail: `EU sanctions: nalezeno ${matches.length} možných shod (top: ${top.listedName}).`,
    source: 'eu_sanctions',
    matches: matches.length,
    classification: 'hit',
    loadedAt: new Date(cache.loadedAt).toISOString(),
    topMatch: {
      listedName: top.listedName,
      subjectType: top.subjectType,
      euReferenceNumber: top.euReferenceNumber,
    },
  };
}

export function getEuSanctionsCacheMeta() {
  return {
    loadedAt: cache.loadedAt ? new Date(cache.loadedAt).toISOString() : null,
    entries: cache.entries.length,
    sourceUrl: cache.sourceUrl,
    lastError: cache.lastError,
  };
}
