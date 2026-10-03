/**
 * Audit generovaných smluv → Supabase contract_generations (+ memory fallback).
 */

function cfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return {
    supabaseUrl,
    serviceKey,
    useSupabase: Boolean(supabaseUrl && serviceKey),
  };
}

const memory = [];

function redactSnapshot(crmData = {}) {
  const out = {};
  for (const [k, v] of Object.entries(crmData)) {
    if (/_rc$|rodne_cislo|id_card|cislo_op/i.test(k) && String(v || '').trim()) {
      out[k] = '[redacted]';
    } else {
      out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    }
  }
  return out;
}

export async function storeContractGeneration({
  userId = null,
  templateId,
  templateVersion = null,
  clientAId = null,
  clientBId = null,
  crmData = {},
  outputFormat = 'docx',
} = {}) {
  const payload = {
    user_id: userId || null,
    template_id: String(templateId || '').slice(0, 80),
    template_version: templateVersion ? String(templateVersion).slice(0, 40) : null,
    client_a_id: clientAId || null,
    client_b_id: clientBId || null,
    payload_snapshot: redactSnapshot(crmData),
    output_format: String(outputFormat || 'docx').slice(0, 20),
  };

  memory.push({ ...payload, created_at: new Date().toISOString(), id: `mem_${memory.length + 1}` });
  if (memory.length > 200) memory.shift();

  const { supabaseUrl, serviceKey, useSupabase } = cfg();
  if (!useSupabase || !payload.template_id) {
    return { ok: true, stored: 'memory', id: memory.at(-1)?.id };
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/contract_generations`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.warn('[contract_generations]', res.status, t.slice(0, 200));
      return { ok: true, stored: 'memory', warning: `supabase ${res.status}` };
    }
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    return { ok: true, stored: 'supabase', id: row?.id };
  } catch (e) {
    console.warn('[contract_generations]', e.message);
    return { ok: true, stored: 'memory', warning: e.message };
  }
}

export function getMemoryContractGenerations(limit = 30) {
  return memory.slice(-limit).reverse();
}
