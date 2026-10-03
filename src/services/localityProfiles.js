/**
 * Soft locality profiles — Supabase + in-memory seed fallback.
 */

import {
  formatLocalityProfileLine,
  placeKeyFromParts,
  placeKeysFromAnalysis,
  foldPlace,
} from '../lib/localityPlaceKey.js';

/** Seed, dokud neběží migrace 0029 / Supabase. */
const SYSTEM_SEED = [
  {
    id: 'seed-liskovec',
    user_id: null,
    place_key: 'liskovec',
    municipality_name: 'Lískovec',
    cadastral_area: 'Lískovec u Frýdku-Místku',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'klid', 'frydecko'],
    notes:
      'Klidná vesnická část Frýdku-Místku — večer spíš mrtvo, vhodné pro rodiny hledající klid než městský ruch.',
    source: 'system',
    confidence: 'high',
  },
  {
    id: 'seed-liskovec-fm',
    user_id: null,
    place_key: 'liskovec|frydek-mistek',
    municipality_name: 'Lískovec',
    cadastral_area: 'Lískovec u Frýdku-Místku',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'klid'],
    notes: 'Klidná vesnická část Frýdku-Místku.',
    source: 'system',
    confidence: 'high',
  },
  {
    id: 'seed-paskov',
    user_id: null,
    place_key: 'paskov',
    municipality_name: 'Paskov',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'msk'],
    notes: 'Menší obec u Ostravy — spíš klidnější než město.',
    source: 'system',
    confidence: 'medium',
  },
  {
    id: 'seed-baska',
    user_id: null,
    place_key: 'baska',
    municipality_name: 'Baška',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'frydecko'],
    notes: 'Obec u Frýdku-Místku — typicky klidnější, sezónně ruch u vody.',
    source: 'system',
    confidence: 'medium',
  },
  {
    id: 'seed-poruba',
    user_id: null,
    place_key: 'poruba',
    municipality_name: 'Poruba',
    vibe: 'sidliste',
    noise_feel: 'prumer',
    tags: ['ostrava', 'sidliste'],
    notes: 'Ostrava-Poruba — sídlištní charakter, dobré služby.',
    source: 'system',
    confidence: 'medium',
  },
  {
    id: 'seed-vinohrady',
    user_id: null,
    place_key: 'vinohrady',
    municipality_name: 'Vinohrady',
    vibe: 'centrum',
    noise_feel: 'hlucne',
    tags: ['praha', 'centrum'],
    notes: 'Praha-Vinohrady — městský ruch, služby, vyšší poptávka.',
    source: 'system',
    confidence: 'medium',
  },
  {
    id: 'seed-vinohrady-praha',
    user_id: null,
    place_key: 'vinohrady|praha',
    municipality_name: 'Vinohrady',
    vibe: 'centrum',
    noise_feel: 'prumer',
    tags: ['praha'],
    notes: 'Pražské Vinohrady — atraktivní městská čtvrť.',
    source: 'system',
    confidence: 'medium',
  },
  {
    id: 'seed-frenstat',
    user_id: null,
    place_key: 'frenstat-pod-radhostem',
    municipality_name: 'Frenštát pod Radhoštěm',
    vibe: 'primesti',
    noise_feel: 'tiche',
    tags: ['beskydy', 'msk'],
    notes: 'Podhorské město — spíš klidnější, rekreace / Beskydy.',
    source: 'system',
    confidence: 'medium',
  },
];

const memoryUserProfiles = new Map(); // key: `${userId||'anon'}::${placeKey}` → profile

function cfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return {
    supabaseUrl,
    serviceKey,
    useSupabase: Boolean(supabaseUrl && serviceKey),
  };
}

function headers(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id ?? null,
    placeKey: row.place_key,
    municipalityName: row.municipality_name || null,
    cadastralArea: row.cadastral_area || null,
    vibe: row.vibe || null,
    noiseFeel: row.noise_feel || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    notes: row.notes || '',
    source: row.source || 'broker',
    confidence: row.confidence || 'medium',
    updatedAt: row.updated_at || null,
  };
}

async function supabaseSelectByKeys(keys) {
  const { supabaseUrl, serviceKey, useSupabase } = cfg();
  if (!useSupabase || !keys.length) return [];

  const inList = keys.map((k) => `"${String(k).replace(/"/g, '')}"`).join(',');
  const url =
    `${supabaseUrl}/rest/v1/locality_profiles` +
    `?place_key=in.(${inList})` +
    `&select=*` +
    `&order=user_id.nullsfirst,updated_at.desc`;

  try {
    const res = await fetch(url, { headers: headers(serviceKey) });
    if (!res.ok) {
      if (res.status !== 404) {
        const t = await res.text().catch(() => '');
        console.warn('[locality] select', res.status, t.slice(0, 160));
      }
      return [];
    }
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn('[locality] select failed:', e.message);
    return [];
  }
}

/**
 * Preferuj osobní profil makléře, jinak systémový.
 */
export async function resolveLocalityProfile(analysis, { userId = null } = {}) {
  const keys = placeKeysFromAnalysis(analysis);
  if (!keys.length) return null;

  // Memory user overrides first
  if (userId) {
    for (const k of keys) {
      const hit = memoryUserProfiles.get(`${userId}::${k}`);
      if (hit) return { ...normalizeRow(hit), matchedKey: k, from: 'memory' };
    }
  }
  for (const k of keys) {
    const hit = memoryUserProfiles.get(`system::${k}`);
    if (hit) return { ...normalizeRow(hit), matchedKey: k, from: 'memory' };
  }

  const rows = await supabaseSelectByKeys(keys);
  if (rows.length) {
    const userRow = userId ? rows.find((r) => r.user_id === userId && keys.includes(r.place_key)) : null;
    const systemRow = rows.find((r) => r.user_id == null && keys.includes(r.place_key));
    const pick = userRow || systemRow;
    if (pick) {
      return { ...normalizeRow(pick), matchedKey: pick.place_key, from: 'supabase' };
    }
  }

  for (const k of keys) {
    const seed = SYSTEM_SEED.find((s) => s.place_key === k);
    if (seed) return { ...normalizeRow(seed), matchedKey: k, from: 'seed' };
  }

  return null;
}

export async function attachLocalityProfile(analysis, opts = {}) {
  if (!analysis || analysis.notFound) return analysis;
  try {
    let profile = await resolveLocalityProfile(analysis, opts);
    if (!profile) {
      const { inferLocalityProfileFromAnalysis } = await import('../lib/inferLocalityProfile.js');
      const inferred = inferLocalityProfileFromAnalysis(analysis);
      if (inferred) {
        const keys = placeKeysFromAnalysis(analysis);
        const placeKey = keys[0] || placeKeyFromParts({ municipality: inferred.municipalityName });
        if (placeKey) {
          profile = await rememberSystemLocalityProfile({
            placeKey,
            municipalityName: inferred.municipalityName,
            cadastralArea: analysis.ku || null,
            vibe: inferred.vibe,
            noiseFeel: inferred.noiseFeel,
            tags: inferred.tags,
            notes: inferred.notes,
            source: 'ai',
            confidence: inferred.confidence,
          });
          if (profile) profile.from = 'inferred';
        }
      }
    }
    if (profile) {
      analysis.localityProfile = profile;
      analysis.localityProfileLine = formatLocalityProfileLine({
        vibe: profile.vibe,
        noise_feel: profile.noiseFeel,
        notes: profile.notes,
        source: profile.source,
      });
    }
  } catch (e) {
    console.warn('[locality] attach failed:', e.message);
  }
  return analysis;
}

/** Systémový / AI profil (user_id null) — memory + Supabase pokud žije. */
export async function rememberSystemLocalityProfile({
  placeKey,
  municipalityName,
  cadastralArea,
  vibe,
  noiseFeel,
  tags = [],
  notes = '',
  source = 'ai',
  confidence = 'low',
} = {}) {
  const key = foldPlace(placeKey).replace(/\s+/g, '-') || placeKeyFromParts({ municipality: municipalityName });
  if (!key) return null;

  const row = {
    id: `mem-${key}`,
    user_id: null,
    place_key: key,
    municipality_name: municipalityName || null,
    cadastral_area: cadastralArea || null,
    vibe: vibe || null,
    noise_feel: noiseFeel || null,
    tags: Array.isArray(tags) ? tags : [],
    notes: notes || null,
    source,
    confidence,
    updated_at: new Date().toISOString(),
  };

  // Nedrť high-confidence system seed
  const existingSeed = SYSTEM_SEED.find((s) => s.place_key === key);
  if (existingSeed && existingSeed.confidence === 'high' && source === 'ai') {
    return normalizeRow(existingSeed);
  }

  memoryUserProfiles.set(`system::${key}`, row);

  const { supabaseUrl, serviceKey, useSupabase } = cfg();
  if (useSupabase) {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/locality_profiles`, {
        method: 'POST',
        headers: {
          ...headers(serviceKey),
          Prefer: 'resolution=ignore-duplicates,return=representation',
        },
        body: JSON.stringify({
          user_id: null,
          place_key: key,
          municipality_name: row.municipality_name,
          cadastral_area: row.cadastral_area,
          vibe: row.vibe,
          noise_feel: row.noise_feel,
          tags: row.tags,
          notes: row.notes,
          source,
          confidence,
        }),
      });
      if (res.ok) {
        const saved = await res.json();
        const first = Array.isArray(saved) ? saved[0] : saved;
        if (first) return normalizeRow(first);
      }
    } catch (e) {
      console.warn('[locality] system upsert:', e.message);
    }
  }

  return normalizeRow(row);
}

/**
 * Upsert profilu (makléř / AI). Service role — respektuje user_id.
 */
export async function upsertLocalityProfile({
  userId,
  placeKey,
  municipalityName,
  cadastralArea,
  vibe,
  noiseFeel,
  tags = [],
  notes = '',
  source = 'broker',
  confidence = 'medium',
} = {}) {
  const key = foldPlace(placeKey).replace(/\s+/g, '-') || placeKeyFromParts({ municipality: municipalityName });
  if (!key) throw new Error('Chybí place_key / obec.');
  if (!userId) throw new Error('Pro uložení profilu je potřeba přihlášený makléř.');

  const row = {
    user_id: userId,
    place_key: key,
    municipality_name: municipalityName || null,
    cadastral_area: cadastralArea || null,
    vibe: vibe || null,
    noise_feel: noiseFeel || null,
    tags: Array.isArray(tags) ? tags : [],
    notes: notes || null,
    source,
    confidence,
    updated_at: new Date().toISOString(),
  };

  memoryUserProfiles.set(`${userId}::${key}`, row);

  const { supabaseUrl, serviceKey, useSupabase } = cfg();
  if (!useSupabase) {
    return { ...normalizeRow(row), from: 'memory', persisted: false };
  }

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/locality_profiles?on_conflict=user_id,place_key`,
      {
        method: 'POST',
        headers: {
          ...headers(serviceKey),
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(row),
      },
    );
    if (!res.ok) {
      // unique index je partial — fallback: patch by filter
      const patchUrl =
        `${supabaseUrl}/rest/v1/locality_profiles` +
        `?user_id=eq.${encodeURIComponent(userId)}` +
        `&place_key=eq.${encodeURIComponent(key)}`;
      const patch = await fetch(patchUrl, {
        method: 'PATCH',
        headers: headers(serviceKey),
        body: JSON.stringify(row),
      });
      if (!patch.ok) {
        const t = await patch.text().catch(() => '');
        console.warn('[locality] upsert', patch.status, t.slice(0, 180));
        return { ...normalizeRow(row), from: 'memory', persisted: false };
      }
      const patched = await patch.json();
      return {
        ...normalizeRow(Array.isArray(patched) ? patched[0] : patched || row),
        from: 'supabase',
        persisted: true,
      };
    }
    const saved = await res.json();
    return {
      ...normalizeRow(Array.isArray(saved) ? saved[0] : saved),
      from: 'supabase',
      persisted: true,
    };
  } catch (e) {
    console.warn('[locality] upsert failed:', e.message);
    return { ...normalizeRow(row), from: 'memory', persisted: false };
  }
}

export { SYSTEM_SEED, formatLocalityProfileLine, placeKeysFromAnalysis };
