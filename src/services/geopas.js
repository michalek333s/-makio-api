/**
 * GeoPas API — oficiální endpointy (token v query parametru `t`).
 * Dokumentace: https://geopas.cz/api.api/documentation
 *
 * Volání jen z backendu (klíč v .env). Frontend používá /api/property/*.
 *
 * Dev server (e-mail od GeoPas): GEOPAS_DEV_IP=85.207.0.17
 * (připojení na IP, SNI/Host = geopas.cz)
 */

import https from 'node:https';
import { parseWsdpLvPayload } from './wsdpLvParser.js';
import { trackGeopasCall, trackWsdpResult } from './geopasEndpointStatus.js';
import { normalizePropertyQuery } from '../lib/extractPropertyQuery.js';
import {
  isWsdpTestEnvEnabled,
  resolveWsdpAccessMode,
} from '../lib/wsdpTestMode.js';

const SEARCH_ENTITIES = 'address,land,cadastral_area';

/** V test=true režimu GeoPas vrací stále stejné ukázkové LV — stačí jedno volání na proces. */
let wsdpTestSampleParsed = null;

function geopasEnv() {
  return {
    apiToken: String(process.env.GEOPAS_API_KEY || '').trim(),
    devIp: String(process.env.GEOPAS_DEV_IP || '').trim(),
    wsdpLogin: String(process.env.GEOPAS_WSDP_LOGIN || '').trim(),
    wsdpPassword: String(process.env.GEOPAS_WSDP_PASSWORD || '').trim(),
    wsdpTest: isWsdpTestEnvEnabled(),
  };
}

// ─── HTTP (fetch + volitelný dev IP jako u curl --resolve) ───────────────────
function geopasHttpsGet(path, query = {}) {
  const { apiToken, devIp } = geopasEnv();
  if (!apiToken) {
    return Promise.reject(new Error('GEOPAS_API_KEY není nastaven v .env souboru'));
  }

  const params = new URLSearchParams({ t: apiToken });
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }

  const hostname = devIp || 'geopas.cz';
  const requestPath = `/api/${path}?${params.toString()}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        port: 443,
        path: requestPath,
        method: 'GET',
        servername: 'geopas.cz',
        headers: {
          Host: 'geopas.cz',
          Accept: 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let json;
          try {
            json = body ? JSON.parse(body) : {};
          } catch {
            reject(new Error(`GeoPas neplatná JSON odpověď (${res.statusCode})`));
            return;
          }
          if (res.statusCode >= 400 || json.error) {
            const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error ?? body);
            reject(new Error(`GeoPas API chyba ${res.statusCode}: ${msg}`));
            return;
          }
          resolve(json);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function unwrapData(response) {
  if (Array.isArray(response?.data)) return response.data;
  if (response?.data && typeof response.data === 'object') {
    if (response.data.base64EncodedFile) return [response.data];
    return [response.data];
  }
  return [];
}

function parseJsonField(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseWgsPoint(definitionPoint) {
  const geo = parseJsonField(definitionPoint);
  const coords = geo?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return { lat: null, lng: null };
  const [lng, lat] = coords;
  return { lat: Number(lat), lng: Number(lng) };
}

function formatAddressLine(entity, detail) {
  if (detail?.street_name) {
    const co = detail.co ? `/${detail.co}` : '';
    const psc = detail.psc ? `, ${detail.psc}` : '';
    const city = detail.municipality_name || entity.reference_name || '';
    return `${detail.street_name} ${detail.cp || ''}${co}${psc}${city ? `, ${city}` : ''}`.replace(/\s+/g, ' ').trim();
  }
  const suffix = entity.reference_name && !entity.name.includes(entity.reference_name)
    ? `, ${entity.reference_name}`
    : '';
  return `${entity.name}${suffix}`;
}

// ─── Endpointy ───────────────────────────────────────────────────────────────
export async function entityByTerm(term, entities = SEARCH_ENTITIES) {
  const res = await geopasHttpsGet('entityByTerm', { term, entities });
  return unwrapData(res);
}

export async function addressByCode(code) {
  const rows = unwrapData(await geopasHttpsGet('addressByCode', { code }));
  return rows[0] ?? null;
}

export async function landByCode(code) {
  const rows = unwrapData(await geopasHttpsGet('landByCode', { code }));
  return rows[0] ?? null;
}

export async function poiByAddress(code) {
  return unwrapData(await geopasHttpsGet('poiByAddress', { code }));
}

export async function waterFloodByLand(landKnId) {
  return unwrapData(await geopasHttpsGet('waterFloodByLand', { code: landKnId }));
}

export async function noiseByLand(landKnId) {
  return unwrapData(await geopasHttpsGet('noiseByLand', { code: landKnId }));
}

/** Radon v bodě — GeoPas používá x=lng, y=lat (WGS84). */
export async function radonByPoint(lat, lng) {
  if (lat == null || lng == null) return [];
  return unwrapData(await geopasHttpsGet('radonByPoint', { x: lng, y: lat }));
}

/** Územní plán v bodě (WGS84) — volitelný endpoint, selhání neblokuje analýzu. */
export async function urbanPlanByPoint(lat, lng) {
  if (lat == null || lng == null) return [];
  return unwrapData(await geopasHttpsGet('urbanPlanByPoint', { x: lng, y: lat }));
}

/** Exekuce podle obce (demografie) — parametr `code` = municipality_code. */
export async function executionByMunicipality(municipalityCode) {
  if (municipalityCode == null || municipalityCode === '') return [];
  return unwrapData(await geopasHttpsGet('executionByMunicipality', { code: municipalityCode }));
}

/** Měsíční nezaměstnanost podle obce. */
export async function unemploymentByMunicipality(municipalityCode) {
  if (municipalityCode == null || municipalityCode === '') return [];
  return unwrapData(await geopasHttpsGet('unemploymentByMunicipality', { code: municipalityCode }));
}

/** Věkové skupiny podle obce (doplňková demografie, ne Safety Score). */
export async function ageByMunicipality(municipalityCode) {
  if (municipalityCode == null || municipalityCode === '') return [];
  return unwrapData(await geopasHttpsGet('ageByMunicipality', { code: municipalityCode }));
}

/**
 * Sjednocení demografických odpovědí GeoPas → tvar pro scoring.js
 * (foreclosures.perHundred, demographics.unemploymentRate).
 */
export function mapMunicipalityStats({ executionRows = [], unemploymentRows = [], ageRows = [], municipalityCode = null, municipalityName = null } = {}) {
  const exec = Array.isArray(executionRows) ? executionRows[0] : executionRows;
  const unemp = Array.isArray(unemploymentRows) ? unemploymentRows[0] : unemploymentRows;
  const age = Array.isArray(ageRows) ? ageRows[0] : ageRows;

  const pickNum = (obj, keys) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== '' && Number.isFinite(Number(obj[k]))) return Number(obj[k]);
    }
    return null;
  };

  const perHundred = pickNum(exec, [
    'per_hundred',
    'perHundred',
    'executions_per_100',
    'execution_per_100',
    'rate_per_100',
    'rate',
    'value',
    'exekuce_na_100',
  ]);
  const unemploymentRate = pickNum(unemp, [
    'unemployment_rate',
    'unemploymentRate',
    'rate',
    'percent',
    'percentage',
    'value',
    'nezamestnanost',
  ]);

  if (perHundred == null && unemploymentRate == null && !age) {
    return null;
  }

  return {
    code: municipalityCode,
    name: municipalityName,
    foreclosures:
      perHundred != null
        ? { perHundred, raw: exec, source: 'GeoPas executionByMunicipality' }
        : null,
    demographics: {
      unemploymentRate: unemploymentRate ?? null,
      age: age || null,
      source: unemploymentRate != null ? 'GeoPas unemploymentByMunicipality' : null,
    },
    crime: null, // GeoPas zatím crime endpoint nemá
  };
}

/**
 * WSDP / LV — na dev: test=true + libovolný login/password (GeoPas doporučuje test/test).
 * Ukázkové LV je vždy stejné → v test režimu voláme API jen jednou na proces.
 *
 * @returns {{ ok: true, data: object } | { ok: false, error: string, hint: string }}
 */
export async function wsdpLvByLand(landKnId, { test = false } = {}) {
  const { wsdpLogin, wsdpPassword, wsdpTest } = geopasEnv();
  const useTestFlag = test || wsdpTest;
  const hasRealWsdp = Boolean(wsdpLogin && wsdpPassword);

  // Test režim: vždy ukázkové LV + isTestSample (i s credentials — nesmí vypadat jako live)
  if (useTestFlag && !hasRealWsdp) {
    if (wsdpTestSampleParsed) {
      return { ok: true, data: wsdpTestSampleParsed, reusedTestSample: true };
    }
  }

  const query = { code: landKnId };
  if (useTestFlag) {
    query.test = 'true';
    query.login = hasRealWsdp ? wsdpLogin : process.env.GEOPAS_WSDP_DEV_LOGIN || 'test';
    query.password = hasRealWsdp ? wsdpPassword : process.env.GEOPAS_WSDP_DEV_PASSWORD || 'test';
  } else if (hasRealWsdp) {
    query.login = wsdpLogin;
    query.password = wsdpPassword;
  } else {
    return {
      ok: false,
      error: 'Chybí GEOPAS_WSDP_LOGIN a GEOPAS_WSDP_PASSWORD',
      hint: 'Pro bezplatné ukázkové LV na dev nastavte GEOPAS_WSDP_TEST=true (login/password test/test).',
    };
  }

  try {
    const json = await geopasHttpsGet('wsdpLvByLand', query);
    const rows = unwrapData(json);
    const raw = rows[0] ?? null;
    if (!raw) {
      return {
        ok: false,
        error: 'GeoPas wsdpLvByLand vrátil prázdná data',
        hint: 'Ověřte parcelu (land_kn_id) nebo WSDP oprávnění u GeoPas.',
      };
    }
    const data = parseWsdpLvPayload(raw, {
      isTestSample: useTestFlag,
    }) || { ...raw, isTestSample: useTestFlag };
    if (useTestFlag) {
      data.isTestSample = true;
      if (!hasRealWsdp) wsdpTestSampleParsed = data;
    }
    return { ok: true, data };
  } catch (e) {
    const msg = e.message || String(e);
    console.warn('[GeoPas] wsdpLvByLand:', msg);
    return {
      ok: false,
      error: msg,
      hint:
        'Dev: GEOPAS_WSDP_TEST=true. Produkcě: GEOPAS_WSDP_TEST=false + skutečné WSDP od GeoPas.',
    };
  }
}

/** Zpětná kompatibilita pro staré volání — vrací jen řádek nebo null. */
export async function wsdpLvByLandRow(landKnId, opts) {
  const res = await wsdpLvByLand(landKnId, opts);
  return res.ok ? res.data : null;
}

// ─── Vyhledávání (našeptávač) ────────────────────────────────────────────────
export async function searchProperty(query, { useCache = true } = {}) {
  const q = query.trim();
  if (useCache) {
    const { loadSearchCache, storeSearchCache } = await import('./geopasCacheStore.js');
    const cached = await loadSearchCache(q);
    if (cached) return { results: cached, fromCache: true };
  }

  const hits = await searchEntities(q);
  const typeRank = { address: 0, land: 1, cadastral_area: 2 };
  const ranked = [...hits].sort((a, b) => {
    const ra = typeRank[a.type] ?? 9;
    const rb = typeRank[b.type] ?? 9;
    if (ra !== rb) return ra - rb;
    return (Number(b.sr) || 0) - (Number(a.sr) || 0);
  });
  const results = ranked.slice(0, 10).map((hit) => {
    const { lat, lng } = parseWgsPoint(hit.definition_point);
    return {
      id: hit.code,
      code: hit.code,
      type: hit.type,
      address: formatAddressLine(hit),
      name: hit.name,
      municipality: hit.reference_name,
      lat,
      lng,
      score: hit.sr,
    };
  });
  const out = { results };
  if (useCache) {
    const { storeSearchCache } = await import('./geopasCacheStore.js');
    await storeSearchCache(q, results);
  }
  return out;
}

const PARCEL_QUERY_RE = /\b(\d{1,6})\s*\/\s*(\d{1,4})\b/;
const CP_QUERY_RE = /^(.+?)\s+(\d{1,4})(?:\s*,\s*.+)?$/u;

function cpParts(query) {
  const q = normalizePropertyQuery(query.trim());
  const m = q.match(CP_QUERY_RE);
  if (!m || PARCEL_QUERY_RE.test(q)) return null;
  return { place: m[1].trim(), num: m[2], full: q };
}

function buildSearchTerms(query) {
  const q = normalizePropertyQuery(query.trim());
  const terms = [q];
  if (q !== query.trim()) terms.push(query.trim());

  const cp = cpParts(q);
  if (cp) {
    terms.unshift(`${cp.place} ${cp.num}`, `${cp.num} ${cp.place}`);
    if (q.includes(',')) terms.unshift(q);
  }

  const parcel = q.match(PARCEL_QUERY_RE);
  if (parcel) {
    const num = `${parcel[1]}/${parcel[2]}`;
    const root = parcel[1];
    const rest = q.replace(PARCEL_QUERY_RE, '').replace(/^[,.:;\s]+/, '').trim();
    // Place-first terms first — GeoPas u „2201/1 Vinohrady“ ignoruje KÚ a vrací náhodné obce
    if (rest) {
      terms.unshift(
        `${rest} ${root}`,
        `${rest} ${num}`,
        `${num} ${rest}`,
        `${root} ${rest}`,
      );
      // „Praha Vinohrady“ → zkus i samotné Vinohrady + číslo (API to umí líp)
      const parts = rest.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        const last = parts[parts.length - 1];
        terms.unshift(`${last} ${root}`, `${last} ${num}`);
      }
    }
    terms.push(num, root);
  }
  return [...new Set(terms.filter(Boolean))];
}

function foldSimple(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function pickBestEntity(hits, query) {
  const q = normalizePropertyQuery(query).toLowerCase();
  const parcel = q.match(PARCEL_QUERY_RE);
  const addresses = hits.filter((h) => h.type === 'address');
  const lands = hits.filter((h) => h.type === 'land');

  if (parcel) {
    const pNum = `${parcel[1]}/${parcel[2]}`;
    const root = parcel[1];
    const rest = foldSimple(q.replace(PARCEL_QUERY_RE, '').replace(/^[,.:;\s]+/, '').trim());
    const landCandidates = lands.filter((h) => {
      const n = String(h.name || '');
      return n.includes(pNum) || n === root || n.startsWith(`${root}/`) || n.includes(root);
    });
    const pool = landCandidates.length ? landCandidates : lands;
    if (pool.length && rest.length >= 3) {
      const scored = pool
        .map((h) => {
          const blob = foldSimple(`${h.name || ''} ${h.reference_name || ''} ${h.address || ''}`);
          let placeScore = 0;
          for (const token of rest.split(/[^a-z0-9]+/).filter((t) => t.length >= 3)) {
            if (blob.includes(token)) placeScore += token.length >= 5 ? 5 : 2;
          }
          if (rest.includes('vinohrad') && blob.includes('vinohrad')) placeScore += 20;
          if (rest.includes('praha') && blob.includes('praha')) placeScore += 15;
          if (rest.includes('liskovec') && blob.includes('liskovec')) placeScore += 20;
          // Číslo parcely samo o sobě NESMÍ vyhrát (jinak vždy první 2201/1 = Bystřice)
          if (placeScore <= 0) return { h, score: 0 };
          let score = placeScore;
          if (String(h.name || '').includes(pNum)) score += 3;
          else if (String(h.name || '') === root) score += 1;
          return { h, score };
        })
        .sort((a, b) => b.score - a.score);
      if (scored[0]?.score > 0) return scored[0].h;
      // Place known but no hit in this batch — do NOT fall back to random Bystřice
      return null;
    }
    const landHit =
      lands.find((h) => String(h.name || '').includes(pNum)) ||
      lands.find((h) => String(h.name || '') === root || String(h.name || '').startsWith(`${root}/`));
    if (landHit) return landHit;
  }

  const cp = cpParts(q);
  if (cp) {
    const { place, num } = cp;
    const numRe = new RegExp(`\\b${num}\\b`);
    const placeNorm = place.toLowerCase();
    const placeFold = foldSimple(place);
    const placeTokens = placeFold.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    const scoredAddr = addresses
      .map((h) => {
        const name = (h.name || '').toLowerCase();
        const nameFold = foldSimple(h.name || '');
        const ref = foldSimple(h.reference_name || '');
        const blob = `${nameFold} ${ref}`;
        let score = 0;
        if (numRe.test(name)) score += 5;
        // Obec v reference_name (např. „Lískovec, Frýdek-Místek“) > ulice jinde
        if (placeTokens.length && placeTokens.every((t) => ref.includes(t))) score += 14;
        else if (name.includes(placeNorm) || blob.includes(placeFold)) score += 8;
        if (ref.includes(placeTokens[0] || placeFold)) score += 3;
        // False friend: Paskovská při dotazu „Paskov 100“
        if (
          placeFold.length >= 4 &&
          nameFold.includes(placeFold) &&
          nameFold !== placeFold &&
          !ref.includes(placeFold) &&
          !/^\s*$/.test(ref)
        ) {
          score -= 8;
        }
        // Soft prior MSK: obec → správný okres / ne false friend
        if (placeFold === 'liskovec' && (ref.includes('frydek') || blob.includes('frydek'))) score += 20;
        if (placeFold === 'paskov' && ref.includes('paskov') && !nameFold.includes('paskovska')) score += 12;
        if (placeFold.includes('sedliste') && blob.includes('slezsk')) score += 22;
        if (placeFold.includes('sedliste') && (blob.includes('frydek') || ref.includes('sedliste'))) score += 18;
        if (placeFold.includes('sedliste') && blob.includes('jimramov')) score -= 25;
        if (placeFold.includes('smilovice') && (blob.includes('trinec') || blob.includes('tesin'))) score += 18;
        if (placeFold.includes('moravka') && placeFold.includes('frydlant') && blob.includes('mala moravka')) {
          score -= 30;
        }
        if (
          (placeFold === 'moravka' || (placeFold.startsWith('moravka') && !placeFold.includes('mala'))) &&
          blob.includes('mala moravka')
        ) {
          score -= 35;
        }
        if (placeFold.includes('moravka') && /\bmoravka\b/.test(blob) && !blob.includes('mala')) score += 18;
        if (placeFold.includes('baska') && (blob.includes('baska') || blob.includes('kuncick'))) score += 12;
        if (placeFold.includes('frydlant') && blob.includes('ostravic')) score += 20;
        // Multi-token place: všechny tokeny ≥4 v blob (např. „sedliste … frydku“)
        if (placeTokens.length >= 2) {
          const strong = placeTokens.filter((t) => t.length >= 4);
          const hitN = strong.filter((t) => blob.includes(t)).length;
          if (hitN === strong.length) score += 16;
          else if (hitN >= 1 && strong.some((t) => ref.includes(t))) score += 6;
        }
        return { h, score };
      })
      .sort((a, b) => b.score - a.score);
    if (scoredAddr[0]?.score >= 5) return scoredAddr[0].h;

    const exactCp = addresses.find((h) => {
      const name = (h.name || '').toLowerCase();
      return name.includes(placeNorm) && numRe.test(name);
    });
    if (exactCp) return exactCp;

    const looseCp = addresses.find((h) => numRe.test(h.name || ''));
    if (looseCp) return looseCp;
  }

  const exact = addresses.find((h) => h.name?.toLowerCase().includes(q.split(',')[0].trim()));
  return exact || addresses[0] || lands[0] || hits[0] || null;
}

async function searchEntities(query) {
  const terms = buildSearchTerms(query);
  const qNorm = normalizePropertyQuery(query);
  const parcel = qNorm.match(PARCEL_QUERY_RE);
  const placeRest = parcel
    ? foldSimple(qNorm.replace(PARCEL_QUERY_RE, '').replace(/^[,.:;\s]+/, '').trim())
    : '';

  let merged = [];
  for (const term of terms) {
    const batch = await entityByTerm(term);
    merged = merged.concat(batch);

    // U parcely s KÚ: čekej na land hit s místem — „praha“ v adrese nestačí (jinak skončíme u č.p. 2201/5)
    if (placeRest.length >= 3) {
      const tokens = placeRest.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
      const landWithPlace = merged.some((h) => {
        if (h.type !== 'land') return false;
        const blob = foldSimple(`${h.name || ''} ${h.reference_name || ''} ${h.address || ''}`);
        return tokens.some((t) => blob.includes(t));
      });
      if (landWithPlace) break;
      if (merged.length >= 50) break;
      continue;
    }

    if (merged.length >= 3) break;
  }
  const seen = new Set();
  return merged.filter((h) => {
    const key = `${h.type}:${h.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mapPoiToAmenities(poiList) {
  const schools = [];
  const transit = [];
  const health = [];

  for (const p of poiList || []) {
    const item = {
      name: p.name,
      type: p.type,
      subtype: p.subtype,
      distanceM: p.direct_distance ? Math.round(Number(p.direct_distance)) : null,
    };
    if (p.type === 'school') schools.push(item);
    else if (p.type === 'traffic') transit.push({ ...item, type: 'transit_stop' });
    else if (['hospital', 'pharmacy', 'clinic'].includes(p.type)) health.push(item);
  }
  return { schools, transit, health, raw: poiList };
}

function mapFloodZones(floodRows) {
  if (!floodRows?.length) {
    return { zone: 'mimo záplavovou zónu', level: 'low', zones: [] };
  }
  return {
    zone: 'záplavové území',
    level: 'elevated',
    zones: floodRows,
  };
}

function mapZoning(rows) {
  if (!rows?.length) return null;
  const row = rows[0];
  if (!row || typeof row !== 'object') return null;

  const pick = (obj, keys) => {
    for (const k of keys) {
      const v = obj[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  };

  const landUse = pick(row, [
    'land_use',
    'landUse',
    'vyuziti',
    'usage',
    'category',
    'type',
    'name',
    'label',
    'urceni',
    'zone_name',
  ]);
  const maxBuildupRate = pick(row, [
    'max_buildup',
    'maxBuildup',
    'maxBuildupRate',
    'zastavitelnost',
    'buildup_rate',
    'coefficient',
  ]);
  const heightRegulation = pick(row, [
    'height',
    'max_height',
    'height_regulation',
    'heightRegulation',
    'vyskova_regulace',
    'max_floors',
  ]);

  if (!landUse && !maxBuildupRate && !heightRegulation) {
    return { landUse: null, maxBuildupRate: null, heightRegulation: null, raw: rows, partial: true };
  }

  return {
    landUse: landUse || 'nezjištěno',
    maxBuildupRate: maxBuildupRate || '—',
    heightRegulation: heightRegulation || '—',
    raw: rows,
    source: 'GeoPas urbanPlanByPoint',
  };
}

function resolveWsdpAccess() {
  return resolveWsdpAccessMode();
}

function extractOwnerName(wsdp) {
  if (!wsdp) return null;
  const direct =
    wsdp.owner ||
    wsdp.vlastnik ||
    wsdp.owner_name ||
    wsdp.vlastnik_jmeno;
  if (direct && typeof direct === 'string') return direct.trim();

  const owners = wsdp.owners || wsdp.vlastnici || wsdp.subjects;
  if (Array.isArray(owners) && owners.length) {
    const first = owners[0];
    if (typeof first === 'string') return first.trim();
    const name =
      first?.name ||
      first?.jmeno ||
      [first?.prijmeni, first?.jmeno].filter(Boolean).join(' ') ||
      first?.nazev;
    if (name) return String(name).trim();
  }
  return null;
}

function mapWsdpToParcel(wsdp, land) {
  if (!wsdp) {
    return {
      lv: '—',
      owner: null,
      cadastralTerritory: land?.cadastral_area_name ?? '—',
      area: land?.area ? `${land.area} m²` : '—',
      landNumber: land?.land_number,
      liens: [],
    };
  }
  const liens = [];
  const rawLiens = wsdp.liens || wsdp.zastavni_prava || wsdp.encumbrances;
  if (Array.isArray(rawLiens)) {
    for (const l of rawLiens) {
      liens.push({
        type: l.type || l.druh || l.description || 'Zápis na LV',
        note: l.note || l.popis || '',
      });
    }
  }
  return {
    lv: wsdp.lv_number || wsdp.lv || wsdp.cislo_lv || '—',
    owner: extractOwnerName(wsdp),
    cadastralTerritory: land?.cadastral_area_name ?? wsdp.cadastral_area_name ?? '—',
    area: land?.area ? `${land.area} m²` : '—',
    landNumber: land?.land_number,
    liens,
    raw: wsdp,
    isTestSample: Boolean(wsdp?.isTestSample),
  };
}

// ─── Kompletní analýza ───────────────────────────────────────────────────────
export async function getFullPropertyAnalysis(query, { useCache = true, code = null, type = null } = {}) {
  if (useCache) {
    const { loadPropertyAnalysisCache } = await import('./geopasCacheStore.js');
    const cached = await loadPropertyAnalysisCache(String(query || '').trim() || `${type}:${code}`);
    if (cached?.geopasRaw) {
      return { ...cached.geopasRaw, fromGeopasCache: true };
    }
  }

  let entity = null;
  let addressDetail = null;
  let land = null;
  let addressCode = null;
  let landKnId = null;

  const hintType = type ? String(type).trim() : null;
  const hintCode = code != null && String(code).trim() !== '' ? String(code).trim() : null;

  if (hintType === 'cadastral_area') {
    const err = new Error(
      'Vybrali jste jen katastrální území. Doplňte číslo popisné nebo parcelu (např. Lískovec 537).',
    );
    err.status = 400;
    throw err;
  }

  if (hintCode && hintType === 'address') {
    addressCode = hintCode;
    addressDetail = await addressByCode(addressCode);
    landKnId = addressDetail?.construction_land_kn_id;
    if (landKnId) land = await landByCode(landKnId);
    entity = {
      type: 'address',
      code: addressCode,
      name: addressDetail?.street_name
        ? `${addressDetail.street_name} ${addressDetail.cp || ''}`.trim()
        : String(query || addressCode),
      reference_name: addressDetail?.municipality_name || '',
      definition_point: addressDetail?.definition_point_wgs,
    };
  } else if (hintCode && hintType === 'land') {
    landKnId = hintCode;
    land = await landByCode(landKnId);
    entity = {
      type: 'land',
      code: landKnId,
      name: land?.land_number || String(query || landKnId),
      reference_name: land?.cadastral_area_name || land?.municipality_name || '',
      definition_point: land?.definition_point_wgs,
    };
  } else {
    const hits = await searchEntities(String(query || '').trim());
    if (!hits.length) {
      throw new Error(
        'Nemovitost nenalezena. Zkuste číslo popisné + obec (např. Lískovec 537, Frýdek-Místek), ulici s číslem, nebo parcelu (2201/1 Vinohrady).',
      );
    }

    entity = pickBestEntity(hits, query);
    if (!entity) {
      throw new Error(
        'Nalezené parcely neodpovídají zadanému místu (k.ú./obec). Upřesněte např. „2201/1 Praha Vinohrady“ nebo „4136/8 Lískovec u Frýdku-Místku“.',
      );
    }

    if (entity.type === 'address') {
      addressCode = entity.code;
      addressDetail = await addressByCode(addressCode);
      landKnId = addressDetail?.construction_land_kn_id;
      if (landKnId) land = await landByCode(landKnId);
    } else if (entity.type === 'land') {
      landKnId = entity.code;
      land = await landByCode(landKnId);
    } else {
      const err = new Error('Nalezen pouze katastrální území — upřesněte adresu nebo parcelu.');
      err.status = 400;
      throw err;
    }
  }

  if (!landKnId && !land) {
    throw new Error('K adrese se nepodařilo dohledat parcelu v katastru.');
  }
  if (!land) land = await landByCode(landKnId);

  const { lat, lng } = parseWgsPoint(land?.definition_point_wgs || entity.definition_point);
  const addressLine = formatAddressLine(entity, addressDetail);

  const endpointStatus = [];

  const wsdpStarted = Date.now();
  const wsdpPromise = wsdpLvByLand(landKnId).then((r) => {
    endpointStatus.push(trackWsdpResult('wsdpLvByLand', r, wsdpStarted));
    return r;
  });

  const municipalityCode =
    land?.municipality_code || addressDetail?.municipality_code || null;
  const municipalityName =
    land?.municipality_name || addressDetail?.municipality_name || null;

  const [poiWrapped, floodWrapped, noiseWrapped, radonWrapped, zoningWrapped, execWrapped, unempWrapped, ageWrapped, wsdpResult] =
    await Promise.all([
      addressCode
        ? trackGeopasCall('poiByAddress', () => poiByAddress(addressCode))
        : Promise.resolve({
            status: { name: 'poiByAddress', ok: true, empty: true, ms: 0, error: null, skipped: true },
            data: [],
          }),
      trackGeopasCall('waterFloodByLand', () => waterFloodByLand(landKnId)),
      trackGeopasCall('noiseByLand', () => noiseByLand(landKnId)),
      lat != null && lng != null
        ? trackGeopasCall('radonByPoint', () => radonByPoint(lat, lng))
        : Promise.resolve({
            status: { name: 'radonByPoint', ok: true, empty: true, ms: 0, error: null, skipped: true },
            data: [],
          }),
      lat != null && lng != null
        ? trackGeopasCall('urbanPlanByPoint', () => urbanPlanByPoint(lat, lng))
        : Promise.resolve({
            status: { name: 'urbanPlanByPoint', ok: true, empty: true, ms: 0, error: null, skipped: true },
            data: [],
          }),
      municipalityCode
        ? trackGeopasCall('executionByMunicipality', () => executionByMunicipality(municipalityCode))
        : Promise.resolve({
            status: {
              name: 'executionByMunicipality',
              ok: true,
              empty: true,
              ms: 0,
              error: null,
              skipped: true,
            },
            data: [],
          }),
      municipalityCode
        ? trackGeopasCall('unemploymentByMunicipality', () =>
            unemploymentByMunicipality(municipalityCode),
          )
        : Promise.resolve({
            status: {
              name: 'unemploymentByMunicipality',
              ok: true,
              empty: true,
              ms: 0,
              error: null,
              skipped: true,
            },
            data: [],
          }),
      municipalityCode
        ? trackGeopasCall('ageByMunicipality', () => ageByMunicipality(municipalityCode))
        : Promise.resolve({
            status: { name: 'ageByMunicipality', ok: true, empty: true, ms: 0, error: null, skipped: true },
            data: [],
          }),
      wsdpPromise,
    ]);

  for (const w of [poiWrapped, floodWrapped, noiseWrapped, radonWrapped, zoningWrapped, execWrapped, unempWrapped, ageWrapped]) {
    if (!w.status.skipped) endpointStatus.push(w.status);
  }

  endpointStatus.unshift(
    { name: 'entityByTerm', ok: true, empty: false, ms: 0, error: null },
    { name: 'landByCode', ok: true, empty: !land, ms: 0, error: null },
  );
  if (addressCode) {
    endpointStatus.push({ name: 'addressByCode', ok: true, empty: !addressDetail, ms: 0, error: null });
  }

  const poiList = poiWrapped.data ?? [];
  const floodRows = floodWrapped.data ?? [];
  const noiseRows = noiseWrapped.data ?? [];
  const radonRows = radonWrapped.data ?? [];
  const wsdp = wsdpResult?.ok ? wsdpResult.data : null;

  const amenities = mapPoiToAmenities(poiList);
  const parcel = mapWsdpToParcel(wsdp, land);
  const flood = mapFloodZones(floodRows);
  const geology = mapRadon(radonRows);
  const zoning = mapZoning(zoningWrapped.data ?? []);
  const municipality = mapMunicipalityStats({
    executionRows: execWrapped.data ?? [],
    unemploymentRows: unempWrapped.data ?? [],
    ageRows: ageWrapped.data ?? [],
    municipalityCode,
    municipalityName,
  });

  const region = land?.region_name || addressDetail?.region_name || entity.reference_name;

  return {
    property: {
      address: addressLine,
      addressId: addressCode,
      parcelId: landKnId,
      landNumber: land?.land_number,
      lat,
      lng,
      region: region?.includes('Praha') ? 'Praha' : region?.includes('Brno') ? 'Brno' : region,
      area: land?.area,
      areaSqm: land?.area ? Number(land.area) : null,
      municipalityId: municipalityCode,
      cadastralArea: land?.cadastral_area_name || null,
      entityType: entity.type,
    },
    parcel,
    flood,
    noise: noiseRows,
    geology,
    municipality,
    zoning,
    amenities,
    fetchedAt: new Date().toISOString(),
    wsdpAccess: resolveWsdpAccess(),
    geopasMeta: {
      entityCode: entity.code,
      landKnId,
      municipalityCode,
      wsdpAccess: resolveWsdpAccess(),
      wsdpOk: Boolean(wsdpResult?.ok),
      wsdpError: wsdpResult?.ok ? null : wsdpResult?.error || null,
      wsdpHint: wsdpResult?.ok ? null : wsdpResult?.hint || null,
      endpointStatus,
      endpoints: endpointStatus.map((e) => e.name),
    },
  };
}

function mapRadon(radonRows) {
  if (!radonRows?.length) return { radon: { level: 'nezjištěno', rows: [] } };
  const row = radonRows[0];
  const risk = String(row?.risk || row?.category || row?.level || '').toLowerCase();
  let level = 'nezjištěno';
  if (/vysok|high|3/.test(risk)) level = 'high';
  else if (/střed|medium|2/.test(risk)) level = 'medium';
  else if (/nízk|low|1/.test(risk)) level = 'low';
  return { radon: { level, rows: radonRows } };
}

/** Rychlá diagnostika GeoPas — lehké volání entityByTerm + stav WSDP konfigurace. */
export async function probeGeopasHealth() {
  const env = geopasEnv();
  const { status, data } = await trackGeopasCall('entityByTerm', () =>
    entityByTerm('Praha 1', 'address'),
  );
  return {
    configured: Boolean(env.apiToken),
    devIp: env.devIp || null,
    wsdpAccess: resolveWsdpAccess(),
    probe: status,
    sampleResults: Array.isArray(data) ? data.length : 0,
    checkedAt: new Date().toISOString(),
  };
}
