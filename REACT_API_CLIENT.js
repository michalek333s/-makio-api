/**
 * Nemio API Client
 * 
 * Tento soubor patří do vašeho React projektu:
 *   src/services/api.js
 * 
 * Použití v komponentách:
 *   import { analyzeProperty, generateListing } from '../services/api';
 * 
 * Nahrazuje přímé volání Gemini/GeoPas z frontendu.
 * Všechny API klíče jsou teď bezpečně na backendu.
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// ─── Pomocná fetch funkce s error handlingem ──────────────────────────────────
async function apiCall(endpoint, options = {}) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `API chyba: ${res.status}`);
  }

  return data;
}

// ═══════════════════════════════════════════════════════════════
//  ANALÝZA NEMOVITOSTI
// ═══════════════════════════════════════════════════════════════

/**
 * Kompletní analýza nemovitosti přes GeoPas
 * Nahrazuje: simulateKatastrFetch()
 * 
 * @param {string} query - adresa nebo číslo parcely
 * @returns {Promise<object>} - analýza s safety score, katastrem, záplatami...
 */
export async function analyzeProperty(query) {
  return apiCall('/api/property/analyze', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

/**
 * Rychlé vyhledávání pro našeptávač
 */
export async function searchProperty(q) {
  return apiCall(`/api/property/search?q=${encodeURIComponent(q)}`);
}

// ═══════════════════════════════════════════════════════════════
//  AI ASISTENT
// ═══════════════════════════════════════════════════════════════

/**
 * AI chat asistent
 * Nahrazuje: přímé volání Gemini API z App.jsx
 * 
 * @param {string} message - zpráva od makléře
 * @param {Array}  history - předchozí konverzace
 * @param {string} clientsContext - seznam klientů z CRM
 */
export async function sendChatMessage(message, history = [], clientsContext = '') {
  return apiCall('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({
      message,
      history,
      clientsContext,
      currentDate: new Date().toLocaleDateString('cs-CZ', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      }),
    }),
  });
}

/**
 * Generování empatického inzerátu (GPT-4o)
 * Nahrazuje: handleGenerateListing()
 */
export async function generateListing(propertyInfo, vibe, targetBuyer) {
  return apiCall('/api/ai/listing', {
    method: 'POST',
    body: JSON.stringify({ propertyInfo, vibe, targetBuyer }),
  });
}

/**
 * Analýza fotky pro homestaging (GPT-4o Vision)
 * 
 * @param {string} imageBase64 - fotka jako base64 string
 * @param {string} mimeType - 'image/jpeg' nebo 'image/png'
 */
export async function analyzePhoto(imageBase64, mimeType = 'image/jpeg') {
  return apiCall('/api/ai/staging', {
    method: 'POST',
    body: JSON.stringify({ imageBase64, mimeType }),
  });
}

/**
 * AI cenová strategie na základě analýzy nemovitosti
 */
export async function getValuationStrategy(propertyAnalysis, sellerGoal = 'balanced') {
  return apiCall('/api/ai/valuation-strategy', {
    method: 'POST',
    body: JSON.stringify({ propertyAnalysis, sellerGoal }),
  });
}

// ═══════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

export async function checkBackendHealth() {
  return apiCall('/api/health');
}
