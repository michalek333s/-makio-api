import { looksLikePropertyQuestion, hasConcretePropertyTarget } from './extractPropertyQuery.js';
import { isRadarMarketQuery } from './chatIntent.js';
import { looksLikeLocalityInfoQuery } from './localityInfoQuery.js';
import { isGeneralExpertQuery } from './generalExpertQuery.js';

const GEOPAS_KEYWORDS =
  /\b(parcela|parcely|lv\b|katastr|záplav|hluk|okolí|vlastník|geopas|k\.?\s*ú\.?|výměra|katastrální)\b/iu;

const CRM_ONLY =
  /\b(?:(?:přidej|přidat|přidje|pridje|pridej|pridat)\s+klient|založ\s+klient|nový\s+klient|ulož\s+do\s+crm|schůzk[ua]?\s+(na|v)|kalendář|sms\s+klient)\b/iu;

/** Dotaz patří agentovi GeoPas (Claude tool-use), ne CRM JSON chatu. */
export function isGeopasChatMessage(message) {
  const m = String(message || '').trim();
  if (!m) return false;
  if (isGeneralExpertQuery(m)) return false;
  if (looksLikeLocalityInfoQuery(m)) return false;
  if (isRadarMarketQuery(m)) return false;

  const hasKw = GEOPAS_KEYWORDS.test(m);
  const looksProp = looksLikePropertyQuestion(m);
  if (!looksProp && !hasKw) return false;
  if (CRM_ONLY.test(m) && !/\d{1,6}\s*\/\s*\d{1,4}/.test(m)) return false;

  // „zkontroluj LV“ bez parcely/adresy → upřesnění přes Gemini, ne prázdný GeoPas
  if (hasKw && !hasConcretePropertyTarget(m, {}) && !/\d/.test(m)) {
    return false;
  }

  return true;
}
