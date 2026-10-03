/**
 * Mirror of frontend Reel Format Library (validation on server).
 */

export const REEL_FORMAT_IDS = [
  'quick_teaser',
  'standard_tour',
  'voiceover_presentation',
  'before_after_reveal',
];

export const REEL_FORMATS = {
  quick_teaser: {
    id: 'quick_teaser',
    title: 'Rychlá Upoutávka',
    photoCount: { min: 1, max: 1 },
    motionCycle: ['dolly_in'],
    supportsVoiceoverScript: false,
    requiresBeforeAfterPair: false,
  },
  standard_tour: {
    id: 'standard_tour',
    title: 'Prohlídka bytu',
    photoCount: { min: 4, max: 6 },
    // 1. fotka = ideálně exteriér/dron přístup; další = místnosti
    motionCycle: ['drone_in', 'dolly_in', 'pan_right', 'dolly_in', 'crane_up'],
    supportsVoiceoverScript: true,
    requiresBeforeAfterPair: false,
  },
  voiceover_presentation: {
    id: 'voiceover_presentation',
    title: 'Staging prezentace',
    photoCount: { min: 5, max: 8 },
    motionCycle: ['pan_right', 'dolly_in', 'orbit', 'crane_up', 'pan_right'],
    supportsVoiceoverScript: true,
    requiresBeforeAfterPair: false,
  },
  before_after_reveal: {
    id: 'before_after_reveal',
    title: 'Před / Po Stagingu',
    photoCount: { min: 2, max: 2 },
    motionCycle: ['dolly_in', 'orbit'],
    supportsVoiceoverScript: false,
    requiresBeforeAfterPair: true,
  },
};

export function getStudioFormat(id) {
  return REEL_FORMATS[id] || null;
}

export function motionForClip(format, index) {
  const cycle = format?.motionCycle?.length ? format.motionCycle : ['dolly_in'];
  return cycle[index % cycle.length];
}
