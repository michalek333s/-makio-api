/**
 * Sestavení promptů a parametrů pro maximální kvalitu Decor8 stagingu.
 * Priorita: NEMĚNIT architekturu místnosti (dveře, okna, stěny).
 */

const ROOM_API_LABELS = {
  livingroom: 'living room',
  bedroom: 'bedroom',
  kitchen: 'kitchen',
  office: 'home office',
  diningroom: 'dining room',
};

/**
 * Nejdůležitější část promptu — musí být na začátku (model čte od začátku).
 */
const ARCHITECTURE_LOCK =
  'STRICT VIRTUAL STAGING — furniture and decor ONLY. ' +
  'The room shell is LOCKED and must match the input photo pixel-for-pixel in architecture: ' +
  'do NOT add, remove, move, or alter ANY doors, door frames, windows, walls, wall openings, niches, columns, ceiling, or floor layout. ' +
  'If a wall has no door in the photo, it must stay with no door. ' +
  'Every existing door and window must keep the exact same count, position, size, and shape. ' +
  'Never invent new doorways or windows.';

const PLACEMENT_LOCK =
  'FURNITURE PLACEMENT — realistic professional interior layout: ' +
  'Place all major furniture against SOLID walls only. ' +
  'Never place a sofa, bed, or desk in the center of the room or floating in open floor space. ' +
  'Never block windows, glass doors, patio doors, or doorways with furniture — keep every opening fully visible and accessible. ' +
  'Sofa: backrest against a solid wall, facing into the room; coffee table directly in front of the sofa on a rug. ' +
  'Leave clear walking paths to every door and terrace entrance. ' +
  'Plants and lamps in corners or beside furniture, not in traffic paths.';

const ROOM_PLACEMENT = {
  livingroom:
    'Living room layout: sofa anchored to the longest solid wall (away from windows), armchairs optional along side walls, TV or art on opposite solid wall if visible.',
  bedroom:
    'Bedroom layout: bed headboard against a solid wall (not under or blocking a window), nightstands flush beside the bed.',
  kitchen:
    'Kitchen layout: cabinets and appliances along walls; island only if the photo clearly allows it without blocking paths.',
  office:
    'Office layout: desk against a solid wall or under window with clear floor space; chair tucked in, bookshelf on a side wall.',
  diningroom:
    'Dining layout: dining table centered on open floor with chairs; not blocking doors or window access.',
};

const PHOTO_PREFIX =
  'Photorealistic virtual staging for a real estate listing. Professional interior photograph, natural daylight, realistic shadows and material textures, correct furniture scale.';

const PHOTO_SUFFIX =
  'Magazine-quality real estate photo. No people, no text, no CGI. Furniture sits naturally on the existing floor only.';

const AVOID_HINTS =
  'Forbidden: new doors, new windows, new openings, warped walls, floating furniture, sofa in room center, furniture blocking windows or glass doors, wrong perspective, duplicated architectural elements.';

const MAX_API_PROMPT_CHARS = 2500;

/** Decor8 default = 2 (1536px), bez příplatku. */
export function getDecor8ScaleFactor() {
  const raw = Number(process.env.DECOR8_SCALE_FACTOR);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 2) {
    return Math.floor(raw);
  }
  return 2;
}

/**
 * Nižší = věrnější původní místnosti (méně „kreativních“ halucinací).
 * Decor8 default 0.39 — pro RK staging doporučeno 0.15–0.25.
 */
export function getDecor8DesignCreativity() {
  const raw = Number(process.env.DECOR8_DESIGN_CREATIVITY);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) {
    return Math.round(raw * 100) / 100;
  }
  return 0.15;
}

export function getDecor8NumImages(requested) {
  const envDefault = Number(process.env.DECOR8_NUM_IMAGES);
  const fallback =
    Number.isFinite(envDefault) && envDefault >= 1 && envDefault <= 4
      ? Math.floor(envDefault)
      : 1;
  const n = Number(requested);
  if (Number.isFinite(n) && n >= 1 && n <= 4) {
    return Math.floor(n);
  }
  return fallback;
}

/**
 * @param {object} opts
 * @param {string} [opts.userPrompt]
 * @param {string} [opts.apiPrompt]
 * @param {string} [opts.roomTypeApi]
 */
export function buildDecor8ApiPrompt({ userPrompt, apiPrompt, roomTypeApi }) {
  const core = String(apiPrompt || userPrompt || '').trim();
  if (!core) return '';

  const roomKey = String(roomTypeApi || '').trim().toLowerCase();
  const roomLabel = ROOM_API_LABELS[roomKey] ? `Room: ${ROOM_API_LABELS[roomKey]}. ` : '';
  const roomPlacement = ROOM_PLACEMENT[roomKey] ? `${ROOM_PLACEMENT[roomKey]} ` : '';

  const full = [
    ARCHITECTURE_LOCK,
    PLACEMENT_LOCK,
    PHOTO_PREFIX,
    roomLabel,
    roomPlacement,
    `Furnish and decorate only: ${core}`,
    PHOTO_SUFFIX,
    AVOID_HINTS,
  ].join(' ');

  return full.length > MAX_API_PROMPT_CHARS ? full.slice(0, MAX_API_PROMPT_CHARS) : full;
}

export function mapRoomTypeApi(raw, roomTypeMap) {
  const key = String(raw || '').trim();
  return roomTypeMap[key] || null;
}
