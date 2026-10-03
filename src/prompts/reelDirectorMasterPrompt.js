/**
 * Makio ReelDirector Engine v3.1 — source of truth for I2V camera prompts.
 * Priority #1: pixel-faithful room — ZERO furniture redesign / morphing.
 */

export const REEL_DIRECTOR_MASTER_VERSION = '3.1.0';

/** Canonical presets (v3) */
export const REEL_PRESET_IDS = ['dolly_in', 'pan_right', 'orbit', 'crane_up', 'drone_in'];

/** Legacy UI / DB aliases → canonical */
export const REEL_PRESET_ALIASES = {
  dolly_in: 'dolly_in',
  pan_right: 'pan_right',
  orbit: 'orbit',
  crane_up: 'crane_up',
  drone_in: 'drone_in',
  // legacy
  slow_pan: 'pan_right',
  push_in: 'dolly_in',
  orbit_left: 'orbit',
  reveal_up: 'crane_up',
  tilt_up: 'crane_up',
  aerial: 'drone_in',
  drone: 'drone_in',
};

export function normalizeReelPreset(preset) {
  const key = String(preset || '').trim();
  return REEL_PRESET_ALIASES[key] || null;
}

/**
 * Mandatory lock appended to EVERY i2v prompt (Seedance/Kling hallucinate otherwise).
 */
export const REEL_FIDELITY_LOCK =
  'CRITICAL: Keep the exact same room, furniture, cushions, fabrics, colors, and layout as the source photo. ' +
  'Do not redesign, replace, move, or morph any chair, sofa, table, lamp, plant, window, wall, or decor. ' +
  'No new objects. No geometry warping. Only the camera moves; the interior is a frozen locked plate.';

/**
 * Static fallbacks — subtle camera only + hard lock.
 */
export const REEL_MOTION_TEMPLATES = {
  dolly_in:
    '9:16 real-estate plate. Extremely slow micro dolly push-in, tiny depth only. ' +
    'Exact source furniture locked in place, no interior changes. Photoreal, 35mm, smooth.',
  pan_right:
    '9:16 real-estate plate. Extremely slow horizontal truck left to right, minimal parallax. ' +
    'Exact source furniture locked in place, no interior changes. Photoreal, 35mm, smooth.',
  orbit:
    '9:16 real-estate plate. Barely-perceptible level arc, almost static. ' +
    'Exact source furniture locked in place, no interior changes. Photoreal, 35mm, smooth.',
  crane_up:
    '9:16 real-estate plate. Extremely slow micro pedestal rise, tiny vertical move. ' +
    'Exact source furniture locked in place, no interior changes. Photoreal, 35mm, smooth.',
  drone_in:
    '9:16 cinematic real-estate exterior. Slow gentle aerial-style crane / push-in toward the facade. ' +
    'Exact source architecture locked, no morphing. Photoreal, natural light, smooth gimbal.',
};

export const REEL_SHOT_NOTES_CS = {
  dolly_in: 'Velmi jemné příbližení — nábytek beze změny.',
  pan_right: 'Velmi pomalý horizontální posun — nábytek beze změny.',
  orbit: 'Téměř neznatelný oblouk — nábytek beze změny.',
  crane_up: 'Velmi jemný výtah — nábytek beze změny.',
  drone_in: 'Dronový přístup k fasádě — architektura beze změny.',
};

const FORBIDDEN =
  /\b(morphing|morph|redesign|restyle|redecorate|transforming|changing furniture|new furniture|dynamic|evolving|magic|surreal|flowing|moving (?:objects?|furniture|chairs?|sofas?)|replace(?:s|d|ing)? (?:the )?(?:chair|sofa|table|furniture))\b/i;

function wordCount(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export const REEL_EXTERIOR_FIDELITY_LOCK =
  'CRITICAL: Keep the exact same building facade, materials, windows, and landscape as the source photo. ' +
  'Do not redesign architecture. No morphing. Only the camera moves; the exterior is a frozen locked plate.';

/**
 * Build final prompt for providers — always appends fidelity lock.
 * @param {string} base
 * @param {string} [preset]
 */
export function enforceFidelityPrompt(base, preset = 'dolly_in') {
  const presetId = normalizeReelPreset(preset) || 'dolly_in';
  const exterior = presetId === 'drone_in';
  let core = String(base || '').trim() || REEL_MOTION_TEMPLATES[presetId];
  core = core
    .replace(/\b(luxury redesign|home staging|new furniture|modern makeover|stylish update)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (FORBIDDEN.test(core)) {
    core = REEL_MOTION_TEMPLATES[presetId] || REEL_MOTION_TEMPLATES.dolly_in;
  }
  const lock = exterior ? REEL_EXTERIOR_FIDELITY_LOCK : REEL_FIDELITY_LOCK;
  if (!/\b(locked|rigid|static|exact same|frozen)\b/i.test(core)) {
    core = exterior
      ? `${core} Exact source architecture remains frozen and rigid.`
      : `${core} Exact source interior remains frozen and rigid.`;
  }
  if (core.includes(lock.slice(0, 40))) {
    return core;
  }
  return `${core} ${lock}`;
}

export function buildReelDirectorSystemPrompt() {
  return `You are "Makio ReelDirector Engine v3.1", a DoP for real-estate Image-to-Video.

HIGHEST PRIORITY — PHOTO FIDELITY:
The output video MUST look like the SAME photograph with ONLY a tiny camera move.
FORBIDDEN: redesigning rooms, changing chairs/sofas/tables, morphing fabrics, inventing plants, moving lamps, warping walls/windows, "improving" the interior.

RULES:
1. Furniture, textiles, colors, and layout = identical to the source frame for every frame.
2. Camera-only motion: extremely slow, minimal, gimbal-stable.
3. Never use: morphing, redesign, restyle, new furniture, transforming, surreal, flowing.
4. Prefer "micro" / "barely perceptible" motion over dramatic moves (dramatic moves cause AI to invent geometry).

OUTPUT: ONLY JSON
{
  "cameraPrompt": "string under 55 words, English, includes exact-furniture lock",
  "presetApplied": "dolly_in|pan_right|orbit|crane_up",
  "estimatedStabilityScore": "0.99"
}`;
}

/**
 * @param {{ preset: string, roomType?: string, style?: string, imageUrl?: string }} input
 */
export function buildReelDirectorUserPayload({
  preset,
  roomType = 'Living Room',
  style = '',
  imageUrl = '',
}) {
  const presetId = normalizeReelPreset(preset) || String(preset || '').trim();
  return {
    preset: presetId,
    roomType: String(roomType || 'Living Room').trim() || 'Living Room',
    style: String(style || '').trim() || undefined,
    imageUrl: String(imageUrl || '').trim() || undefined,
    durationSeconds: 5,
    aspectRatio: '9:16',
    fidelity: 'exact_source_furniture_locked',
  };
}

/**
 * Validate Claude JSON; fall back to static template if unsafe.
 * @param {object} parsed
 * @param {string} expectedPreset
 */
export function sanitizeDirectorResult(parsed, expectedPreset) {
  const presetId = normalizeReelPreset(expectedPreset) || expectedPreset;
  const template = REEL_MOTION_TEMPLATES[presetId] || REEL_MOTION_TEMPLATES.dolly_in;
  const notes = REEL_SHOT_NOTES_CS[presetId] || REEL_SHOT_NOTES_CS.dolly_in;

  const cameraPrompt = String(parsed?.cameraPrompt || '').trim();
  const applied = normalizeReelPreset(parsed?.presetApplied) || presetId;
  let score = String(parsed?.estimatedStabilityScore ?? '0.99').trim();
  if (!/^\d(\.\d+)?$/.test(score)) score = '0.99';

  const reasons = [];
  if (!cameraPrompt) reasons.push('empty');
  if (wordCount(cameraPrompt) > 55) reasons.push('over_55_words');
  if (!/\b(rigid|static|frozen|locked|exact)\b/i.test(cameraPrompt)) reasons.push('missing_lock');
  if (FORBIDDEN.test(cameraPrompt)) reasons.push('forbidden_words');
  if (applied !== presetId) reasons.push('preset_mismatch');

  if (reasons.length) {
    return {
      cameraPrompt: enforceFidelityPrompt(template, presetId),
      shotNotes: notes,
      presetApplied: presetId,
      estimatedStabilityScore: '0.99',
      hallucinationRisk: 'low',
      usedFallback: true,
      rejectReason: reasons.join(','),
    };
  }

  return {
    cameraPrompt: enforceFidelityPrompt(cameraPrompt, presetId),
    shotNotes: notes,
    presetApplied: presetId,
    estimatedStabilityScore: score,
    hallucinationRisk: Number(score) >= 0.95 ? 'low' : 'medium',
    usedFallback: false,
  };
}

/**
 * Room-aware static template (no Claude).
 */
export function buildStaticCameraPrompt(preset, roomType = 'Living Room', style = '') {
  const presetId = normalizeReelPreset(preset) || 'dolly_in';
  const room = String(roomType || 'Living Room').trim() || 'Living Room';
  const styleBit = String(style || '').trim();
  const roomPhrase = styleBit ? `${styleBit} ${room}` : room;

  const motions = {
    dolly_in: `Extremely slow micro dolly push-in into a ${roomPhrase}.`,
    pan_right: `Extremely slow horizontal truck across a ${roomPhrase}.`,
    orbit: `Barely-perceptible level arc in a ${roomPhrase}.`,
    crane_up: `Extremely slow micro pedestal rise in a ${roomPhrase}.`,
  };

  return enforceFidelityPrompt(
    `9:16 real-estate plate. ${motions[presetId]} Exact source furniture locked.`,
    presetId,
  );
}
