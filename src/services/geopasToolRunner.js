import {
  entityByTerm,
  addressByCode,
  landByCode,
  poiByAddress,
  waterFloodByLand,
  noiseByLand,
  wsdpLvByLand,
} from './geopas.js';

const MAX_JSON_CHARS = 14_000;

function trimPayload(data) {
  const s = JSON.stringify(data);
  if (s.length <= MAX_JSON_CHARS) return s;
  return `${s.slice(0, MAX_JSON_CHARS)}…(zkráceno)`;
}

export async function runGeopasTool(name, input) {
  switch (name) {
    case 'geopas_search_entities': {
      const entities = input.entities || 'address,land,cadastral_area';
      const rows = await entityByTerm(String(input.term).trim(), entities);
      return {
        ok: true,
        count: rows.length,
        results: rows.slice(0, 8).map((r) => ({
          code: r.code,
          type: r.type,
          name: r.name,
          reference_name: r.reference_name,
          score: r.sr,
        })),
      };
    }
    case 'geopas_get_address': {
      const row = await addressByCode(Number(input.code));
      if (!row) return { ok: false, error: 'Adresa nenalezena' };
      return {
        ok: true,
        address: row,
        land_kn_id: row.construction_land_kn_id,
      };
    }
    case 'geopas_get_land': {
      const row = await landByCode(Number(input.kn_id));
      if (!row) return { ok: false, error: 'Parcela nenalezena' };
      return {
        ok: true,
        land: {
          kn_id: row.kn_id,
          land_number: row.land_number,
          area: row.area,
          cadastral_area_name: row.cadastral_area_name,
          municipality_name: row.municipality_name,
        },
      };
    }
    case 'geopas_get_land_environment': {
      const landKnId = Number(input.land_kn_id);
      const addressCode = input.address_code ? Number(input.address_code) : null;
      const [flood, noise, poi] = await Promise.all([
        waterFloodByLand(landKnId).catch((e) => ({ error: e.message })),
        noiseByLand(landKnId).catch((e) => ({ error: e.message })),
        addressCode
          ? poiByAddress(addressCode).catch((e) => ({ error: e.message }))
          : Promise.resolve([]),
      ]);
      const poiSummary = Array.isArray(poi)
        ? {
            schools: poi.filter((p) => p.type === 'school').length,
            transit: poi.filter((p) => p.type === 'traffic').length,
            samples: poi.slice(0, 6).map((p) => ({
              type: p.type,
              name: p.name,
              distance_m: p.direct_distance ? Math.round(Number(p.direct_distance)) : null,
            })),
          }
        : poi;
      return {
        ok: true,
        flood: Array.isArray(flood) ? flood : flood,
        noise: Array.isArray(noise) ? noise.slice(0, 6) : noise,
        poi: poiSummary,
      };
    }
    case 'geopas_get_wsdp_lv': {
      const res = await wsdpLvByLand(Number(input.land_kn_id));
      if (!res.ok) {
        return {
          ok: false,
          error: res.error,
          hint: res.hint,
        };
      }
      return { ok: true, wsdp: res.data };
    }
    default:
      return { ok: false, error: `Neznámý nástroj: ${name}` };
  }
}

export async function runGeopasToolSafe(name, input) {
  try {
    const result = await runGeopasTool(name, input);
    return trimPayload(result);
  } catch (e) {
    return trimPayload({ ok: false, error: e.message || String(e) });
  }
}
