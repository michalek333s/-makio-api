/**
 * Persist / load auditních AML checks (migrace 0033_aml_checks).
 */

function supabaseCfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

function headers(serviceKey, prefer = 'return=representation') {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: prefer,
  };
}

export function isAmlChecksConfigured() {
  return Boolean(supabaseCfg());
}

/**
 * @param {object} row
 * @param {boolean} [row.is_pep]
 * @param {boolean} [row.is_sanctioned]
 * @param {string} [row.isir_status] — clean | in_insolvency | error
 * @param {boolean} [row.screening_incomplete] — ISIR/OpenSanctions selhalo → nikdy „approved“
 */
export function computeRiskAndStatus({
  is_pep,
  is_sanctioned,
  isir_status,
  screening_incomplete = false,
}) {
  const incomplete = Boolean(screening_incomplete) || isir_status === 'error';

  let risk_score = 'low';
  if (isir_status === 'in_insolvency' || is_sanctioned) risk_score = 'high';
  else if (is_pep || incomplete) risk_score = 'medium';

  let check_status = 'approved';
  if (risk_score === 'high') check_status = 'rejected';
  else if (risk_score === 'medium' || incomplete) check_status = 'requires_review';

  return { risk_score, check_status };
}

/**
 * @param {string} userId
 * @param {object} payload
 */
export async function createAmlCheck(userId, payload) {
  if (!userId) {
    throw Object.assign(new Error('Přihlášení vyžadováno'), { status: 401 });
  }

  const screening_incomplete =
    Boolean(payload.screening_incomplete) ||
    payload.isir_status === 'error' ||
    payload.opensanctions_details?.classification === 'incomplete';

  const { risk_score, check_status } = computeRiskAndStatus({
    ...payload,
    screening_incomplete,
  });
  const row = {
    user_id: userId,
    client_type: payload.client_type,
    full_name: String(payload.full_name || '').trim(),
    identifier: String(payload.identifier || '').replace(/[\s/]/g, ''),
    birth_date: payload.birth_date || null,
    address: payload.address || null,
    nationality: payload.nationality ? String(payload.nationality).trim() : null,
    id_document: payload.id_document ? String(payload.id_document).trim() : null,
    in_person_verified: Boolean(payload.in_person_verified),
    representative_name: payload.representative_name
      ? String(payload.representative_name).trim()
      : null,
    representative_id_doc: payload.representative_id_doc
      ? String(payload.representative_id_doc).trim()
      : null,
    representative_birth_date: payload.representative_birth_date || null,
    beneficial_owner: payload.beneficial_owner
      ? String(payload.beneficial_owner).trim()
      : null,
    transaction_type: payload.transaction_type
      ? String(payload.transaction_type).trim()
      : null,
    property_address: payload.property_address
      ? String(payload.property_address).trim()
      : null,
    funds_source: payload.funds_source ? String(payload.funds_source).trim() : null,
    is_pep: Boolean(payload.is_pep),
    is_sanctioned: Boolean(payload.is_sanctioned),
    isir_status: payload.isir_status || 'clean',
    isir_details: payload.isir_details || null,
    ares_data: payload.ares_data || null,
    risk_score,
    check_status,
    note: payload.note || null,
    broker_name: payload.broker_name || null,
    agency_name: payload.agency_name || null,
    opensanctions_details: payload.opensanctions_details || null,
  };

  if (!row.full_name || !row.identifier) {
    throw Object.assign(new Error('Chybí full_name nebo identifier'), { status: 400 });
  }
  if (!['natural_person', 'legal_entity'].includes(row.client_type)) {
    throw Object.assign(new Error('Neplatný client_type'), { status: 400 });
  }

  const cfg = supabaseCfg();
  const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(userId),
  );
  if (!cfg || !uuidOk) {
    // Dev fallback bez Supabase / bez platného JWT
    return {
      ...row,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      _persisted: false,
      _persistError: !cfg
        ? 'Supabase není nastavený — protokol stáhnete z výsledku lustrace.'
        : 'Historie v cloudu se uloží po přihlášení. PDF stáhnete z výsledku lustrace. Pro trvalý zápis spusťte v SQL Editoru migrace 0033–0037.',
    };
  }

  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/aml_checks`, {
    method: 'POST',
    headers: headers(cfg.serviceKey),
    body: JSON.stringify(row),
  });

  const text = await res.text();
  if (!res.ok) {
    console.warn('[aml_checks] insert:', res.status, text.slice(0, 400));
    const low = text.toLowerCase();
    const missingTable =
      res.status === 404 ||
      low.includes('could not find the table') ||
      low.includes('does not exist') ||
      low.includes('pgrst205');
    const missingColumn =
      low.includes('pgrst204') ||
      low.includes('could not find the') && low.includes('column');
    const denied = res.status === 401 || res.status === 403;

    // Retry bez nových §7/§9 sloupců (migrace 0035 ještě neběží)
    if (missingColumn) {
      const {
        nationality: _n,
        id_document: _idDoc,
        in_person_verified: _ipv,
        representative_name: _rn,
        representative_id_doc: _rid,
        representative_birth_date: _rbd,
        beneficial_owner: _ubo,
        transaction_type: _tt,
        property_address: _pa,
        funds_source: _fs,
        ...legacy
      } = row;
      const retry = await fetch(`${cfg.supabaseUrl}/rest/v1/aml_checks`, {
        method: 'POST',
        headers: headers(cfg.serviceKey),
        body: JSON.stringify(legacy),
      });
      const retryText = await retry.text();
      if (retry.ok) {
        const rows = JSON.parse(retryText || '[]');
        return {
          ...(rows[0] || legacy),
          ...row,
          _persisted: true,
          _persistWarning:
            'Sloupce protokolu chybí — spusťte migrace 0035 a 0036 v Supabase (PDF je má z requestu).',
        };
      }
    }

    // Soft-fail: screening už proběhl — vrať výsledek i bez cloudu
    if (missingTable || denied || missingColumn) {
      console.warn(
        '[aml_checks] persist přeskočen — spusťte migrace 0033–0036 v Supabase',
      );
      return {
        ...row,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        _persisted: false,
        _persistError: missingTable
          ? 'Tabulka aml_checks chybí — spusťte SQL migraci 0033 v Supabase.'
          : missingColumn
            ? 'Chybí sloupce protokolu — spusťte 0035–0037 v Supabase SQL Editoru.'
            : 'Supabase odmítl zápis (403) — spusťte 0034_aml_checks_grants.sql nebo zkontrolujte SERVICE_ROLE klíč.',
      };
    }

    throw Object.assign(new Error(`Uložení AML kontroly selhalo (${res.status})`), {
      status: 502,
      code: 'AML_CHECK_SAVE',
      detail: text.slice(0, 200),
    });
  }

  const rows = JSON.parse(text || '[]');
  return { ...(rows[0] || row), _persisted: true };
}

/**
 * @param {string} userId
 * @param {{ limit?: number }} [opts]
 */
export async function listAmlChecks(userId, opts = {}) {
  if (!userId) return [];
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
  const cfg = supabaseCfg();
  if (!cfg) return [];

  const url =
    `${cfg.supabaseUrl}/rest/v1/aml_checks` +
    `?user_id=eq.${encodeURIComponent(userId)}` +
    `&select=*` +
    `&order=created_at.desc` +
    `&limit=${limit}`;

  const res = await fetch(url, { headers: headers(cfg.serviceKey, 'return=representation') });
  if (!res.ok) {
    console.warn('[aml_checks] list:', res.status);
    return [];
  }
  return res.json();
}

/**
 * @param {string} userId
 * @param {string} checkId
 */
export async function getAmlCheckById(userId, checkId) {
  if (!userId || !checkId) return null;
  const cfg = supabaseCfg();
  if (!cfg) return null;

  const url =
    `${cfg.supabaseUrl}/rest/v1/aml_checks` +
    `?user_id=eq.${encodeURIComponent(userId)}` +
    `&id=eq.${encodeURIComponent(checkId)}` +
    `&select=*` +
    `&limit=1`;

  const res = await fetch(url, { headers: headers(cfg.serviceKey) });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows?.[0] || null;
}

export async function getAmlChecksSummary(userId) {
  const rows = await listAmlChecks(userId, { limit: 200 });
  return {
    total: rows.length,
    high: rows.filter((r) => r.risk_score === 'high').length,
    medium: rows.filter((r) => r.risk_score === 'medium').length,
    low: rows.filter((r) => r.risk_score === 'low').length,
    approved: rows.filter((r) => r.check_status === 'approved').length,
    rejected: rows.filter((r) => r.check_status === 'rejected').length,
    requires_review: rows.filter((r) => r.check_status === 'requires_review').length,
  };
}
