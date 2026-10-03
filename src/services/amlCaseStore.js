/**
 * Persist AML cases do Supabase (migrace 0027). Fallback: in-memory Map.
 */

const memory = new Map();

function supabaseCfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

function headers(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function memKey(userId, clientId) {
  return `${userId || 'anon'}:${clientId}`;
}

export function isAmlPersistConfigured() {
  return Boolean(supabaseCfg());
}

export async function loadAmlCase(userId, clientId) {
  const id = String(clientId || '');
  if (!id) return null;

  const cfg = supabaseCfg();
  if (cfg && userId) {
    try {
      const url =
        `${cfg.supabaseUrl}/rest/v1/aml_cases` +
        `?user_id=eq.${encodeURIComponent(userId)}` +
        `&client_id=eq.${encodeURIComponent(id)}` +
        `&select=payload` +
        `&limit=1`;
      const res = await fetch(url, { headers: headers(cfg.serviceKey) });
      if (res.ok) {
        const rows = await res.json();
        if (rows?.[0]?.payload && typeof rows[0].payload === 'object') {
          return rows[0].payload;
        }
      } else if (res.status !== 404) {
        const t = await res.text().catch(() => '');
        if (!/relation .* does not exist|PGRST205/i.test(t)) {
          console.warn('[AML store] load:', res.status, t.slice(0, 160));
        }
      }
    } catch (e) {
      console.warn('[AML store] load error:', e.message);
    }
  }

  return memory.get(memKey(userId, id)) || null;
}

export async function saveAmlCase(userId, amlCase) {
  if (!amlCase?.clientId) return amlCase;
  const clientId = String(amlCase.clientId);
  memory.set(memKey(userId, clientId), amlCase);

  const cfg = supabaseCfg();
  if (!cfg || !userId) return amlCase;

  const row = {
    user_id: userId,
    client_id: clientId,
    client_name: amlCase.clientName || null,
    payload: amlCase,
    status: amlCase.status || null,
    identification_complete: Boolean(amlCase.identificationComplete),
    screening_complete: Boolean(amlCase.screeningComplete),
    updated_at: new Date().toISOString(),
  };

  try {
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/aml_cases?on_conflict=user_id,client_id`, {
      method: 'POST',
      headers: {
        ...headers(cfg.serviceKey),
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      if (/relation .* does not exist|PGRST205|Could not find/i.test(t)) {
        // migrace 0027 ještě neběžela
        return amlCase;
      }
      console.warn('[AML store] save:', res.status, t.slice(0, 200));
    }
  } catch (e) {
    console.warn('[AML store] save error:', e.message);
  }
  return amlCase;
}
