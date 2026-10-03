/**
 * Insolvenční hlídač / Rejstříky — ISIR hasrecord + getsubjects.
 * Preferuje INSHLIDAC_* (isir.info) ; fallback REJSTRIKY_* (rejstriky.info).
 */

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

const DEFAULT_ISIR_BASE = 'https://www.isir.info';

function cleanIdentifier(value) {
  return String(value || '')
    .replace(/[\s/]/g, '')
    .trim();
}

function resolveIsirConfig() {
  const email = String(process.env.INSHLIDAC_EMAIL || process.env.REJSTRIKY_USERNAME || '').trim();
  const password = String(process.env.INSHLIDAC_PASSWORD || process.env.REJSTRIKY_PASSWORD || '').trim();
  let base = String(process.env.INSHLIDAC_BASE_URL || '').trim().replace(/\/$/, '');
  // Legacy / mrtvá doména — DNS ENOTFOUND
  if (!base || /inshlidac\.cz$/i.test(base.replace(/^https?:\/\//, ''))) {
    base = process.env.INSHLIDAC_EMAIL ? DEFAULT_ISIR_BASE : '';
  }
  const usePrimary = Boolean(base || process.env.INSHLIDAC_EMAIL);
  const baseUrl = usePrimary ? base || DEFAULT_ISIR_BASE : 'https://www.rejstriky.info';
  // isir.info / rejstriky očekávají username+password (ne email=)
  const host = baseUrl.replace(/^https?:\/\//, '').toLowerCase();
  const authMode = /isir\.info|rejstriky\.info/.test(host) ? 'username' : 'email';
  return {
    email,
    password,
    baseUrl,
    apiPath: usePrimary ? '/api' : '/api/isir',
    authMode,
  };
}

export function isIsirConfigured() {
  const cfg = resolveIsirConfig();
  return Boolean(cfg.email && cfg.password);
}

async function callIsirEndpoint(endpoint, params) {
  const cfg = resolveIsirConfig();
  if (!cfg.email || !cfg.password) {
    throw Object.assign(new Error('ISIR API není nastaveno (INSHLIDAC_EMAIL/PASSWORD nebo REJSTRIKY_*)'), {
      status: 503,
      code: 'ISIR_NOT_CONFIGURED',
    });
  }

  const body = new URLSearchParams({
    ...(cfg.authMode === 'email' ? { email: cfg.email, password: cfg.password } : {}),
    ...(cfg.authMode === 'username' ? { username: cfg.email, password: cfg.password } : {}),
    ...params,
  });

  const url = `${cfg.baseUrl}${cfg.apiPath}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/xml, application/json, */*' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`ISIR API chyba ${res.status}`), { status: 502, code: 'ISIR_HTTP' });
  }

  // JSON odpověď (některé proxy)
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
    try {
      return { kind: 'json', data: JSON.parse(text) };
    } catch {
      /* continue as XML */
    }
  }

  const parsed = parser.parse(text);
  const status = parsed?.request?.requestinfo?.status;
  if (status !== undefined && status !== 0 && status !== '0') {
    throw Object.assign(
      new Error(parsed?.request?.requestinfo?.statustext || 'ISIR API vrátilo chybu'),
      { status: 502, code: 'ISIR_API' },
    );
  }

  return { kind: 'xml', data: parsed?.request?.answer || parsed };
}

function normalizeCasesFromSubjects(subjectsRaw) {
  let subjects = subjectsRaw;
  if (!subjects) return [];
  if (!Array.isArray(subjects)) subjects = [subjects];

  return subjects.map((s) => ({
    fileNumber:
      String(s.fileNumber || s.casenumber || '').trim() ||
      `${s.spisprefix || 'INS'} ${s.spisnumber || ''}/${s.spisyear || ''}`.trim(),
    court: String(s.court || s.courtname || '—').trim() || '—',
    status: String(s.status || s.currentstatus || 'Neznámý stav').trim(),
    url: s.url || null,
    lastChange: s.lastChange || s.lastmodification || null,
    name: s.name || s.n || `${s.firstname || ''} ${s.surname || ''}`.trim() || null,
  }));
}

function extractHasRecord(payload) {
  if (payload?.kind === 'json') {
    const d = payload.data;
    const v = d?.hasRecord ?? d?.hasrecord ?? d?.answer?.hasrecord ?? d?.data?.hasRecord;
    return String(v).trim().toLowerCase() === 'true' || v === true || v === 1 || v === '1';
  }
  const v = payload?.data?.hasrecord ?? payload?.data?.hasRecord;
  return String(v).trim().toLowerCase() === 'true' || v === true;
}

function extractSubjects(payload) {
  if (payload?.kind === 'json') {
    const d = payload.data;
    const list =
      d?.cases ||
      d?.subjects ||
      d?.answer?.subjects?.subject ||
      d?.data?.subjects ||
      [];
    if (Array.isArray(list) && list[0]?.fileNumber) return list;
    return normalizeCasesFromSubjects(list?.subject || list);
  }
  let subjects = payload?.data?.subjects?.subject;
  return normalizeCasesFromSubjects(subjects);
}

/**
 * @param {{ identifier: string, type: 'rc' | 'ic' }} input
 * @returns {Promise<{ hasRecord: boolean, cases: Array<{fileNumber,court,status}>, isirStatus: string, error?: string }>}
 */
export async function verifyIsir({ identifier, type }) {
  const clean = cleanIdentifier(identifier);
  if (!clean) {
    throw Object.assign(new Error('Chybí identifikátor (RČ nebo IČO)'), { status: 400 });
  }
  if (!['rc', 'ic'].includes(type)) {
    throw Object.assign(new Error("type musí být 'rc' nebo 'ic'"), { status: 400 });
  }

  try {
    const params = type === 'rc' ? { rc: clean } : { ic: clean };
    const hasPayload = await callIsirEndpoint('hasrecord', params);
    const hasRecord = extractHasRecord(hasPayload);

    let cases = [];
    if (hasRecord) {
      const detailPayload = await callIsirEndpoint('getsubjects', params);
      cases = extractSubjects(detailPayload);
    }

    return {
      hasRecord,
      cases,
      isirStatus: hasRecord ? 'in_insolvency' : 'clean',
      checkedAt: new Date().toISOString(),
      dataSource: resolveIsirConfig().baseUrl,
    };
  } catch (err) {
    if (err?.code === 'ISIR_NOT_CONFIGURED') throw err;
    console.warn('[ISIR verify]', err.message);
    return {
      hasRecord: false,
      cases: [],
      isirStatus: 'error',
      error: err.message || 'ISIR nedostupné',
      checkedAt: new Date().toISOString(),
    };
  }
}
