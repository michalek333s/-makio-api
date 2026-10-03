/**
 * Backend nurturing — heuristika + volitelné AI obohacení (Gemini).
 */

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function softList(c) {
  if (Array.isArray(c.softData)) return c.softData.map(String);
  if (Array.isArray(c.soft_data)) return c.soft_data.map(String);
  return [];
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function parseLooseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(`${s.slice(0, 10)}T12:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function lastContactDate(client) {
  const hist = Array.isArray(client.history) ? client.history : [];
  for (const h of hist) {
    const d = parseLooseDate(h.date);
    if (d) return d;
  }
  return null;
}

/** Lokální heuristika — stejná logika jako frontend nurturingTriggers.js */
export function buildLocalNurturingTriggers({ clients = [], events = [], now = new Date() } = {}) {
  const out = [];

  for (const c of clients) {
    if (!c?.id && !c?.name) continue;
    const fn = firstName(c.name);
    const soft = softList(c);
    const last = lastContactDate(c);
    const idleDays = last ? daysBetween(last, now) : 999;

    for (const ev of events) {
      const evClient = String(ev.client || ev.clientName || '');
      if (!evClient.includes(c.name)) continue;
      const evDate = parseLooseDate(ev.date);
      if (!evDate) continue;
      const diff = daysBetween(now, evDate);
      if (diff >= 0 && diff <= 1) {
        out.push({
          id: `event-soon-${c.id}-${ev.id || ev.title}`,
          type: 'event_soon',
          title: diff === 0 ? 'Dnes v agendě' : 'Zítra v agendě',
          body: `${ev.title || 'Událost'} — ${c.name}`,
          clientId: c.id,
          clientName: c.name,
          eventId: ev.id ?? null,
          action: 'CALENDAR',
          priority: 95,
        });
      }
    }

    if (idleDays >= 14) {
      out.push({
        id: `cold-${c.id}`,
        type: 'cold_14',
        title: 'Studený kontakt (14+ dní)',
        body: `${c.name} — ozvěte se krátkou zprávou.`,
        clientId: c.id,
        clientName: c.name,
        action: 'MESSAGE',
        priority: 70,
        suggestedMessage: `Ahoj ${fn}, jen krátce — pořád platí ${c.interest || 'to, co jsme řešili'}? Klidně napište ano/ne, ať vás neotravuju zbytečně.`,
      });
    } else if (idleDays >= 7) {
      out.push({
        id: `warm-${c.id}`,
        type: 'warm_7',
        title: 'Týden bez kontaktu',
        body: `${c.name} — ideální čas na follow-up.`,
        clientId: c.id,
        clientName: c.name,
        action: 'MESSAGE',
        priority: 75,
        suggestedMessage: `Ahoj ${fn}, ozývám se po týdnu. Mám drobnou aktualizaci k ${c.interest || 'vašemu hledání'} — hodí se zítra 10 minut na telefon?`,
      });
    }

    if (soft.length && (c.priority === 'hot' || idleDays >= 5)) {
      const hook = soft[0];
      const softHint = /pes|retrívr|kočk|zvíř/i.test(hook)
        ? 'při výběru myslím i na prostor pro pejska'
        : /rozvod|rozchod/i.test(hook)
          ? 'beru ohled na to, že potřebujete spíš klid a jasné tempo'
          : /dět|škol/i.test(hook)
            ? 'hlídám hlavně klidnou lokalitu a dostupnost škol'
            : /cen|rozpočt|drah/i.test(hook)
              ? 'hlídám hlavně rozumný poměr cena/užitek'
              : `pamatuju si na „${String(hook).slice(0, 40)}“`;
      out.push({
        id: `soft-${c.id}`,
        type: 'soft_tip',
        title: 'Využijte soft data',
        body: `${c.name}: „${soft[0]}"`,
        clientId: c.id,
        clientName: c.name,
        action: 'MESSAGE',
        priority: 60,
        suggestedMessage: `Ahoj ${fn}, ozývám se s tipem — ${softHint}. Hodí se krátký hovor, nebo radši napíšu 2–3 konkrétní nabídky?`,
      });
    }
  }

  const seen = new Set();
  return out
    .filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    })
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .slice(0, 12);
}

/**
 * AI obohacení triggerů — Gemini vrátí max 5 prioritních s empatickými SMS.
 */
export async function enhanceNurturingWithAi({ clients, events, localTriggers, invokeTextLlm, AiTask }) {
  if (!invokeTextLlm || localTriggers.length === 0) return localTriggers;

  const { buildNurturingEnhanceSystemPrompt } = await import('./clientComms.js');

  const summary = clients.slice(0, 25).map((c) => ({
    name: c.name,
    type: c.type,
    priority: c.priority,
    interest: c.interest,
    budget: c.budget,
    soft: softList(c).slice(0, 3),
    context: String(c.context || '').slice(0, 120),
  }));

  const systemPrompt = buildNurturingEnhanceSystemPrompt();

  const userMessage = JSON.stringify({
    clients: summary,
    upcomingEvents: (events || []).slice(0, 20),
    existingTriggers: localTriggers.slice(0, 8),
  });

  const { text: raw } = await invokeTextLlm({
    task: AiTask.CHAT,
    systemPrompt,
    userMessage,
  });

  const cleaned = String(raw || '')
    .replace(/^```json?\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return localTriggers;
  }

  const list = Array.isArray(parsed) ? parsed : parsed.triggers;
  if (!Array.isArray(list) || list.length === 0) return localTriggers;

  return list
    .filter((t) => t && t.title && t.body)
    .map((t, i) => ({
      id: String(t.id || `ai-${i}`),
      type: t.type || 'ai_nurture',
      title: String(t.title).slice(0, 120),
      body: String(t.body).slice(0, 400),
      clientId: t.clientId || null,
      clientName: t.clientName || '',
      action: t.action || 'MESSAGE',
      priority: Number(t.priority) || 65,
      suggestedMessage: t.suggestedMessage ? String(t.suggestedMessage).slice(0, 500) : undefined,
    }))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .slice(0, 10);
}
