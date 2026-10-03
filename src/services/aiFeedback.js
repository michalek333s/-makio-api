/**
 * Ukládání AI feedbacku (opravy makléře) → Supabase ai_feedback.
 *
 * Governance: do system promptu jdou jen řádky s is_approved_for_context = true.
 * Raw 👎/opravy se ukládají jako backlog pro garanta playbooku.
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

const memoryFeedback = [];

/**
 * @param {{
 *   userId?: string|null,
 *   input: string,
 *   aiOutput: string,
 *   correctedOutput?: string|null,
 *   feedbackType?: string|null,
 *   meta?: object,
 *   isApprovedForContext?: boolean,
 * }} row
 */
export async function storeAiFeedback({
  userId = null,
  input,
  aiOutput,
  correctedOutput = null,
  feedbackType = 'other',
  meta = {},
  isApprovedForContext = false,
} = {}) {
  const safeInput = String(input || '').trim().slice(0, 8000);
  const safeOut = String(aiOutput || '').trim().slice(0, 16000);
  if (!safeInput || !safeOut) {
    const err = new Error('input a aiOutput jsou povinné');
    err.status = 400;
    throw err;
  }

  const payload = {
    user_id: userId || null,
    input: safeInput,
    ai_output: safeOut,
    corrected_output: correctedOutput ? String(correctedOutput).trim().slice(0, 16000) : null,
    feedback_type: feedbackType || 'other',
    meta: meta && typeof meta === 'object' ? meta : {},
    // Broker nikdy neschvaluje sám — jen explicitní admin / env override pro testy
    is_approved_for_context: Boolean(isApprovedForContext),
  };

  memoryFeedback.push({
    ...payload,
    created_at: new Date().toISOString(),
    id: `mem_${memoryFeedback.length + 1}`,
    approved_at: payload.is_approved_for_context ? new Date().toISOString() : null,
    approved_by: null,
  });
  if (memoryFeedback.length > 500) memoryFeedback.shift();

  const { supabaseUrl, serviceKey, useSupabase } = cfg();
  if (!useSupabase) {
    return {
      ok: true,
      stored: 'memory',
      id: memoryFeedback.at(-1)?.id,
      pendingApproval: !payload.is_approved_for_context,
    };
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/ai_feedback`, {
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
      console.warn('[ai_feedback] insert', res.status, t.slice(0, 200));
      return {
        ok: true,
        stored: 'memory',
        warning: `supabase ${res.status}`,
        pendingApproval: !payload.is_approved_for_context,
      };
    }
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    return {
      ok: true,
      stored: 'supabase',
      id: row?.id,
      pendingApproval: !Boolean(row?.is_approved_for_context ?? payload.is_approved_for_context),
    };
  } catch (e) {
    console.warn('[ai_feedback] failed:', e.message);
    return {
      ok: true,
      stored: 'memory',
      warning: e.message,
      pendingApproval: !payload.is_approved_for_context,
    };
  }
}

export function getMemoryAiFeedback(limit = 50) {
  return memoryFeedback.slice(-limit).reverse();
}

function mapFeedbackRow(r) {
  return {
    id: r.id || null,
    input: r.input,
    ai_output: r.ai_output,
    corrected_output: r.corrected_output,
    feedback_type: r.feedback_type,
    meta: r.meta || {},
    created_at: r.created_at,
    is_approved_for_context: Boolean(r.is_approved_for_context),
    approved_at: r.approved_at || null,
    approved_by: r.approved_by || null,
  };
}

/**
 * @param {{ limit?: number, userId?: string|null, approvedOnly?: boolean, pendingOnly?: boolean }} opts
 */
export async function loadRecentAiFeedback({
  limit = 20,
  userId = null,
  approvedOnly = false,
  pendingOnly = false,
} = {}) {
  const fromMem = getMemoryAiFeedback(Math.min(80, Math.max(1, limit * 2)))
    .map(mapFeedbackRow)
    .filter((r) => {
      if (approvedOnly && !r.is_approved_for_context) return false;
      if (pendingOnly && r.is_approved_for_context) return false;
      return true;
    })
    .slice(0, limit);

  const { supabaseUrl, serviceKey, useSupabase } = cfg();
  if (!useSupabase) return fromMem;

  try {
    let url =
      `${supabaseUrl}/rest/v1/ai_feedback` +
      `?select=id,input,ai_output,corrected_output,feedback_type,meta,created_at,is_approved_for_context,approved_at,approved_by` +
      `&order=created_at.desc&limit=${Math.min(80, Math.max(1, limit))}`;
    if (userId) url += `&user_id=eq.${encodeURIComponent(userId)}`;
    if (approvedOnly) url += `&is_approved_for_context=eq.true`;
    if (pendingOnly) url += `&is_approved_for_context=eq.false`;

    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
    if (!res.ok) return fromMem;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return fromMem;
    return rows.map(mapFeedbackRow);
  } catch {
    return fromMem;
  }
}

/**
 * Schválení feedbacku do kontextu promptu (governance).
 */
export async function approveAiFeedbackForContext({
  id,
  approvedBy = null,
  approved = true,
} = {}) {
  if (!id) {
    const err = new Error('id je povinné');
    err.status = 400;
    throw err;
  }

  const mem = memoryFeedback.find((r) => r.id === id);
  if (mem) {
    mem.is_approved_for_context = Boolean(approved);
    mem.approved_at = approved ? new Date().toISOString() : null;
    mem.approved_by = approvedBy;
  }

  const { supabaseUrl, serviceKey, useSupabase } = cfg();
  if (!useSupabase) {
    if (!mem) {
      const err = new Error('Feedback nenalezen');
      err.status = 404;
      throw err;
    }
    return { ok: true, id, approved: Boolean(approved), stored: 'memory' };
  }

  const body = {
    is_approved_for_context: Boolean(approved),
    approved_at: approved ? new Date().toISOString() : null,
    approved_by: approvedBy || null,
  };

  const res = await fetch(
    `${supabaseUrl}/rest/v1/ai_feedback?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`Schválení selhalo: ${res.status} ${t.slice(0, 200)}`);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row && !mem) {
    const err = new Error('Feedback nenalezen');
    err.status = 404;
    throw err;
  }
  return { ok: true, id: row?.id || id, approved: Boolean(approved), stored: 'supabase' };
}

/**
 * Jen SCHVÁLENÉ lekce → system prompt.
 * Bez manuálního schválení se do modelu nic z 👎/oprav nepropíše (anti-poisoning).
 */
export async function buildFeedbackLessonsForPrompt({ limit = 10 } = {}) {
  // Záměrně BEZ userId — schválené lekce jsou tenant-wide governance, ne osobní bias jednoho makléře
  const rows = await loadRecentAiFeedback({ limit: 60, approvedOnly: true });
  const downs = rows.filter((r) => {
    const rating = r.meta?.rating;
    return rating === 'down' || rating === 'bad' || Boolean(r.corrected_output);
  });

  const ups = rows.filter((r) => {
    const rating = r.meta?.rating;
    return rating === 'up' || rating === 'good';
  });

  const sections = [];

  const pickDown = downs.slice(0, limit);
  if (pickDown.length) {
    const lines = pickDown.map((r, i) => {
      const inp = String(r.input || '').replace(/\s+/g, ' ').slice(0, 120);
      const fix = String(r.corrected_output || '').replace(/\s+/g, ' ').slice(0, 220);
      const bad = String(r.ai_output || '').replace(/\s+/g, ' ').slice(0, 100);
      const topic = r.meta?.intent || r.feedback_type || 'chat';
      if (fix) {
        return `${i + 1}. [${topic}] Dotaz „${inp}" → špatně; správněji: ${fix}`;
      }
      return `${i + 1}. [${topic}] Dotaz „${inp}" → 👎 (vyhni se: „${bad}…")`;
    });
    sections.push(
      'Lekce ze SCHVÁLENÉHO governance feedbacku (👎 / opravy) — dodržuj:',
      ...lines,
    );
  }

  const pickUp = ups
    .filter((r) => String(r.ai_output || '').length >= 80)
    .slice(0, 4);
  if (pickUp.length) {
    const lines = pickUp.map((r, i) => {
      const inp = String(r.input || '').replace(/\s+/g, ' ').slice(0, 80);
      const good = String(r.ai_output || '').replace(/\s+/g, ' ').slice(0, 160);
      return `${i + 1}. Dotaz „${inp}" → dobrý styl: ${good}…`;
    });
    sections.push('', 'Schválené příklady odpovědí (👍) — drž podobnou hloubku a tón:', ...lines);
  }

  if (!sections.length) {
    return '— (zatím žádné schválené governance lekce; raw 👎 čekají na garanta playbooku)';
  }

  return sections.join('\n').trim();
}

/** Test helper — schválí položku v memory store. */
export function __testApproveMemoryFeedback(id) {
  return approveAiFeedbackForContext({ id, approved: true, approvedBy: null });
}
