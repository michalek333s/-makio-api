/**
 * Cross-portal content hash + price history helpers for Radar Watchdog.
 */

import { createHash } from 'crypto';
import { localityToString } from '../lib/radarNormalize.js';

function normText(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function roundArea(area) {
  const n = Number(area);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n));
}

function roundPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return '';
  // bucket 10k — drobné rozdíly mezi portály nesmí rozbít hash
  return String(Math.round(n / 10_000) * 10_000);
}

/**
 * hash(localita + plocha + cena + dispozice)
 * @param {object} listing
 */
export function buildRadarContentHash(listing) {
  const loc = normText(
    localityToString(listing.locality) ||
      listing.city ||
      listing.location_address ||
      listing.location_district ||
      '',
  );
  const area = roundArea(listing.floorArea ?? listing.floor_area ?? listing.surface_area);
  const price = roundPrice(listing.price);
  const layout = normText(listing.layout || '');
  const raw = `${loc}|${area}|${price}|${layout}`;
  if (!loc && !area && !price && !layout) return null;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export function detectPrivateSeller(listing) {
  if (listing.is_private_seller === true || listing.isPrivateSeller === true) return true;
  if (listing.isAgencyListing === true) return false;
  if (listing.fsboSignal === true) return true;
  if (listing.radarStatus === 'NEW_PRIVATE') return true;
  const blob = `${listing.title || ''} ${listing.description || ''} ${listing.agencyName || ''}`.toLowerCase();
  if (/exkluzivn[ií]|zastoupen[ií]|realitn[ií] kancel|rk\s|makl[eé][rř]/i.test(blob)) {
    if (!/rk nevolat|p[rř][ií]m[yý] majitel|bez realit|soukrom[yý] majitel/i.test(blob)) {
      return false;
    }
  }
  if (/rk nevolat|p[rř][ií]m[yý] majitel|bez realit|soukrom[yý] majitel|majitel nab[ií]z[ií]/i.test(blob)) {
    return true;
  }
  const src = String(listing.source || '');
  return ['bazos', 'bezrealitky', 'facebook', 'facebook_marketplace'].includes(src);
}

export function mapPropertyType(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('dom') || s === 'house') return 'house';
  if (s.includes('pozem') || s === 'land') return 'land';
  if (s.includes('komer') || s === 'commercial') return 'commercial';
  if (s.includes('byt') || s === 'flat' || s === 'apartment' || s === 'byty') return 'flat';
  return 'flat';
}

export function mapDealType(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('pronaj') || s === 'rent') return 'rent';
  return 'sale';
}

/**
 * @param {number|null} oldPrice
 * @param {number|null} newPrice
 * @param {Array} history
 */
export function appendPriceHistory(oldPrice, newPrice, history = []) {
  const prev = Number(oldPrice);
  const next = Number(newPrice);
  if (!Number.isFinite(next) || next <= 0) {
    return { history: Array.isArray(history) ? history : [], dropped: null };
  }
  const hist = Array.isArray(history) ? [...history] : [];
  if (!Number.isFinite(prev) || prev <= 0) {
    hist.push({ price: next, at: new Date().toISOString(), delta: 0 });
    return { history: hist.slice(-40), dropped: null };
  }
  if (Math.abs(prev - next) < 1000) {
    return { history: hist, dropped: null };
  }
  const delta = next - prev;
  hist.push({ price: next, at: new Date().toISOString(), delta });
  return {
    history: hist.slice(-40),
    dropped: delta < 0 ? Math.abs(delta) : null,
  };
}
