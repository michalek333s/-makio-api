/**
 * Detekce a sanitizace WSDP test / ukázkových LV dat.
 * GeoPas test režim vrací stejnou fiktivní LV pro každou parcelu.
 */

/** Známé otisky ukázkové LV (nesmí se tvářit jako živý vlastník). */
const TEST_OWNER_RE =
  /kratochv[ií]l|uk[aá]zkov|testovac[ií]\s+w?sdp|fiktivn/i;
const TEST_LV_RE = /^(1913|0000|9999)$/;

export function isWsdpTestEnvEnabled() {
  const v = String(process.env.GEOPAS_WSDP_TEST || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function hasWsdpCredentials() {
  return Boolean(
    String(process.env.GEOPAS_WSDP_LOGIN || '').trim() &&
      String(process.env.GEOPAS_WSDP_PASSWORD || '').trim(),
  );
}

/**
 * Režim přístupu k LV pro UI / analýzu.
 * GEOPAS_WSDP_TEST=true vždy → 'test' (i když jsou credentials — ukázka není live).
 */
export function resolveWsdpAccessMode() {
  if (isWsdpTestEnvEnabled()) return 'test';
  if (hasWsdpCredentials()) return 'credentials';
  return 'none';
}

export function looksLikeWsdpTestOwner(name) {
  const s = String(name || '').trim();
  if (!s) return false;
  return TEST_OWNER_RE.test(s);
}

export function looksLikeWsdpTestLv(lv) {
  const s = String(lv || '')
    .trim()
    .replace(/^LV\s*/i, '');
  if (!s || s === '—' || s === '-') return false;
  return TEST_LV_RE.test(s);
}

/**
 * True pokud LV data nesmí jít do UI jako „živý vlastník“.
 */
export function isWsdpTestSampleParcel(parcel, ownerAccess) {
  if (ownerAccess === 'test' || isWsdpTestEnvEnabled()) return true;
  if (parcel?.isTestSample) return true;
  if (looksLikeWsdpTestOwner(parcel?.owner)) return true;
  if (Array.isArray(parcel?.raw?.owners)) {
    if (parcel.raw.owners.some((o) => looksLikeWsdpTestOwner(o?.name || o))) return true;
  }
  if (looksLikeWsdpTestLv(parcel?.lv)) return true;
  return false;
}

/**
 * Vyčistí analýzu tak, aby fiktivní vlastník/LV nikdy nevypadaly jako live.
 * Idempotentní — bezpečné volat i na cache hit.
 */
export function sanitizeAnalysisWsdpTest(analysis) {
  if (!analysis || typeof analysis !== 'object') return analysis;

  const access = analysis.ownerAccess || resolveWsdpAccessMode();
  const flagged =
    analysis.isTestOwner === true ||
    access === 'test' ||
    isWsdpTestEnvEnabled() ||
    looksLikeWsdpTestOwner(analysis.owner) ||
    (Array.isArray(analysis.owners) && analysis.owners.some(looksLikeWsdpTestOwner)) ||
    looksLikeWsdpTestLv(analysis.lv);

  if (!flagged) return analysis;

  const next = { ...analysis };
  next.isTestOwner = true;
  next.ownerAccess = 'test';
  next.owner = null;
  next.owners = [];
  next.lv = '—';
  next.ownerMessage =
    next.ownerMessage ||
    'Vlastník a LV nejsou v testovacím režimu WSDP — GeoPas vrací stejnou ukázkovou LV pro všechny parcely. Pro skutečné údaje aktivujte produkční WSDP (GEOPAS_WSDP_TEST=false + login/heslo).';

  if (next.risks && typeof next.risks === 'object') {
    next.risks = {
      ...next.risks,
      liens: [],
      hasExecution: false,
      hasMortgage: false,
    };
  }

  if (next.dataQuality && typeof next.dataQuality === 'object') {
    const fields = { ...(next.dataQuality.fields || {}) };
    fields.owners = {
      status: 'test_sample',
      label: 'Vlastník / LV — testovací WSDP',
      detail:
        'Ukázková data, ne skutečný vlastník. Vypněte GEOPAS_WSDP_TEST a použijte produkční WSDP.',
    };
    next.dataQuality = {
      ...next.dataQuality,
      overall: 'partial',
      summary:
        'Část dat je živá (parcela/poloha), vlastník je v testovacím režimu WSDP.',
      fields,
    };
  }

  return next;
}
