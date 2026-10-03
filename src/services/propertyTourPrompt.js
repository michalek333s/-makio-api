/**
 * Property tour i2v prompts — one room photo → one cinematic clip.
 * Whole-house tour = ordered clips + FFmpeg concat (pipeline).
 */

import { enforceFidelityPrompt } from '../prompts/reelDirectorMasterPrompt.js';

const MOTION_LINE = {
  dolly_in: 'Extremely slow micro dolly push-in into the room focal point.',
  pan_right: 'Extremely slow horizontal truck left to right, minimal parallax.',
  orbit: 'Barely-perceptible level arc around the room focal point, almost static.',
  crane_up: 'Extremely slow micro pedestal rise revealing the space.',
  drone_in:
    'Cinematic real-estate aerial-style approach: slow gentle crane-up / push-in toward the facade or exterior, smooth gimbal, photoreal, no morphing of architecture.',
};

/**
 * @param {{
 *  preset?: string,
 *  roomLabel?: string,
 *  index?: number,
 *  total?: number,
 *  listingTitle?: string,
 * }} opts
 */
export function buildPropertyTourPrompt(opts = {}) {
  const preset = String(opts.preset || 'dolly_in').trim() || 'dolly_in';
  const room = String(opts.roomLabel || 'Living room').trim() || 'Living room';
  const index = Number(opts.index) || 0;
  const total = Math.max(1, Number(opts.total) || 1);
  const motion = MOTION_LINE[preset] || MOTION_LINE.dolly_in;
  const isExterior =
    /exterior|facade|facáda|zahrad|garden|balcony|balkon|drone|approach/i.test(room) ||
    preset === 'drone_in';
  const beat =
    total <= 1
      ? 'Single-room cinematic real-estate teaser.'
      : index === 0
        ? isExterior
          ? `Property tour drone / exterior opening (${index + 1}/${total}).`
          : `Property tour opening shot (${index + 1}/${total}).`
        : index === total - 1
          ? `Property tour closing shot (${index + 1}/${total}).`
          : `Property tour room beat (${index + 1}/${total}).`;

  const base = isExterior
    ? `9:16 cinematic real-estate exterior video. ${beat} ${motion} Exact same building and materials as the source photo. Photoreal, natural light.`
    : `9:16 cinematic real-estate video of this ${room}. ${beat} ${motion} ` +
      `Exact same furniture and architecture as the source photo. Photoreal, smooth gimbal, natural light.`;

  if (isExterior || preset === 'drone_in') {
    return (
      `${base} CRITICAL: Keep the exact same building facade, materials, windows, and landscape as the source photo. ` +
      `Do not redesign architecture. Only the camera moves.`
    );
  }
  return enforceFidelityPrompt(base, preset);
}
