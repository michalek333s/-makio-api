/**
 * Párování inzerátů Radar ↔ klienti CRM (lokalita, dispozice, rozpočet).
 */

const LAYOUT_RE = /\b(\d+\+(?:kk|\d))\b/i;

function parseBudget(raw) {
  const digits = String(raw || '').replace(/\s/g, '').match(/(\d[\d\s]*\d|\d+)/);
  if (!digits) return null;
  const n = parseInt(digits[0].replace(/\D/g, ''), 10);
  return Number.isFinite(n) && n > 50_000 ? n : null;
}

function normalizeLayout(l) {
  if (!l) return null;
  return String(l).toLowerCase().replace(/\s/g, '');
}

function extractLayout(text) {
  const m = String(text || '').match(LAYOUT_RE);
  return m ? normalizeLayout(m[1]) : null;
}

function locationTokens(text) {
  const t = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\w\s\-]/g, ' ');
  return [...new Set(t.split(/\s+/).filter((w) => w.length >= 3))];
}

function localityOverlap(clientText, lead) {
  const hay = normHaystack(lead);
  const tokens = locationTokens(clientText);
  if (!tokens.length) return { hits: [], score: 0 };

  const hits = tokens.filter((tok) => hay.includes(tok));
  if (!hits.length) return { hits: [], score: 0 };

  let score = 20 + Math.min(30, hits.length * 8);
  const cityLike = hits.filter((h) => h.length >= 5);
  if (cityLike.length) score += 10;
  return { hits, score };
}

function normHaystack(lead) {
  return norm(`${lead.locality || ''} ${lead.title || ''}`);
}

function norm(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

/**
 * @param {object} lead
 * @param {object[]} clients
 * @param {{ maxResults?: number }} opts
 */
export function matchClientsToListing(lead, clients = [], { maxResults = 3 } = {}) {
  if (!lead || !Array.isArray(clients) || clients.length === 0) return [];

  const leadPrice = lead.price;
  const leadLayout = normalizeLayout(lead.layout);

  const matches = [];

  for (const c of clients) {
    if (!c?.name) continue;
    let score = 0;
    const reasons = [];

    const budget = parseBudget(c.budget);
    if (budget && leadPrice) {
      if (budget >= leadPrice * 0.85 && budget <= leadPrice * 1.2) {
        score += 35;
        reasons.push('Rozpočet sedí k ceně');
      } else if (budget >= leadPrice * 0.9) {
        score += 22;
        reasons.push('Rozpočet pokrývá cenu');
      } else if (budget >= leadPrice * 0.75) {
        score += 10;
        reasons.push('Rozpočet těsně pod cenou — možná sleva');
      }
    }

    const buyText = [c.address_property_buy, c.interest].filter(Boolean).join(' ');
    const loc = localityOverlap(buyText, lead);
    if (loc.score) {
      score += loc.score;
      reasons.push(`Lokalita: ${loc.hits.slice(0, 3).join(', ')}`);
    }

    const wantLayout = extractLayout(c.interest) || extractLayout(c.address_property_buy);
    if (wantLayout && leadLayout && wantLayout === leadLayout) {
      score += 25;
      reasons.push(`Dispozice ${lead.layout}`);
    } else if (wantLayout && leadLayout) {
      const wantBeds = parseInt(wantLayout, 10);
      const leadBeds = parseInt(leadLayout, 10);
      if (Number.isFinite(wantBeds) && Number.isFinite(leadBeds) && wantBeds === leadBeds) {
        score += 12;
        reasons.push(`Podobná velikost (${leadBeds}+)`);
      }
    }

    if (c.priority === 'hot') {
      score += 8;
      reasons.push('Horký lead v CRM');
    }

    if (score >= 35) {
      matches.push({
        clientId: c.id,
        name: c.name,
        score: Math.min(100, score),
        reasons: reasons.slice(0, 4),
        budget,
        interest: c.interest || c.address_property_buy || '',
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

/** @param {object} lead @param {object[]} clients */
export function attachCrmMatches(lead, clients) {
  const crmMatches = matchClientsToListing(lead, clients);
  const top = crmMatches[0] || null;
  return {
    ...lead,
    crmMatches,
    ai: lead.ai
      ? {
          ...lead.ai,
          crmMatch: top,
          crmMatches,
        }
      : lead.ai,
  };
}
