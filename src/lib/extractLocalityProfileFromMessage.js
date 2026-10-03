/**
 * Z chatu makléře vytáhne soft profil lokality („Lískovec je klidná vesnice“).
 */

import { placeKeyFromParts } from './localityPlaceKey.js';

const VIBE_PATTERNS = [
  { re: /klidn\p{L}*\s+vesnic/iu, vibe: 'klidna_vesnice', noiseFeel: 'tiche' },
  { re: /tich\p{L}*\s+(obec|vesnic|lokalit)/iu, vibe: 'klidna_vesnice', noiseFeel: 'tiche' },
  { re: /klidn\p{L}*\s+(obec|lokalit|čtvrť|ctvrt)/iu, vibe: 'klidna_vesnice', noiseFeel: 'tiche' },
  { re: /sídlišt|sidlist/iu, vibe: 'sidliste', noiseFeel: 'prumer' },
  { re: /centrum\s+měst|v\s+centru/iu, vibe: 'centrum', noiseFeel: 'hlucne' },
  { re: /průmyslov|prumyslov|u\s+dálnic|u\s+dalnic|hlučn\p{L}*\s+lokalit/iu, vibe: 'prumysl', noiseFeel: 'hlucne' },
  { re: /příměst|primest|satelit/iu, vibe: 'primesti', noiseFeel: 'prumer' },
  { re: /rekreačn|chatař|zahrádk/iu, vibe: 'rekreace', noiseFeel: 'tiche' },
];

const STOP = /^(to|tam|tady|lokalita|obec|vesnice|místo|mesto|tadyhle)$/i;

/**
 * @returns {null | { placeKey, municipalityName, vibe, noiseFeel, notes, source, confidence }}
 */
export function extractLocalityProfileFromMessage(message) {
  const m = String(message || '').trim();
  if (!m) return null;

  let vibe = null;
  let noiseFeel = null;
  for (const p of VIBE_PATTERNS) {
    if (p.re.test(m)) {
      vibe = p.vibe;
      noiseFeel = p.noiseFeel;
      break;
    }
  }
  if (!vibe) return null;

  const nameMatch =
    m.match(
      /([\p{L}][\p{L}\d\-]*(?:\s+u\s+[\p{L}][\p{L}\d\s\-]*)?)\s+(?:je|jsou|bývá|mi\s+přijde)/iu,
    ) ||
    m.match(
      /(?:v|ve|na)\s+([\p{L}][\p{L}\d\-]*(?:\s+u\s+[\p{L}][\p{L}\d\s\-]*)?)\s+(?:je|jsou|bývá)?/iu,
    );

  const municipalityName = nameMatch?.[1]?.trim();
  if (!municipalityName || municipalityName.length < 3 || STOP.test(municipalityName)) {
    return null;
  }

  const placeKey = placeKeyFromParts({ municipality: municipalityName });
  if (!placeKey) return null;

  return {
    placeKey,
    municipalityName,
    vibe,
    noiseFeel,
    notes: m.slice(0, 240),
    source: 'broker',
    confidence: 'medium',
  };
}

export function looksLikeLocalityProfileNote(message) {
  return Boolean(extractLocalityProfileFromMessage(message));
}
