/**
 * Claude as ReelDirector Engine v3.0
 * @see ../prompts/REEL_DIRECTOR_MASTER.md
 * @see ../prompts/reelDirectorMasterPrompt.js
 */

import { callClaudeMessages } from './claudeClient.js';
import {
  REEL_DIRECTOR_MASTER_VERSION,
  REEL_PRESET_IDS,
  REEL_MOTION_TEMPLATES,
  REEL_SHOT_NOTES_CS,
  normalizeReelPreset,
  buildReelDirectorSystemPrompt,
  buildReelDirectorUserPayload,
  sanitizeDirectorResult,
  enforceFidelityPrompt,
} from '../prompts/reelDirectorMasterPrompt.js';

/**
 * @param {{ preset: string, roomType?: string, style?: string, imageUrl?: string }} params
 */
export async function generateDirectorPrompt({
  preset,
  roomType = 'Living Room',
  style = '',
  imageUrl = '',
}) {
  const presetId = normalizeReelPreset(preset) || String(preset || '').trim();
  if (!REEL_PRESET_IDS.includes(presetId)) {
    return {
      cameraPrompt: '',
      shotNotes: '',
      presetApplied: '',
      estimatedStabilityScore: '0.00',
      hallucinationRisk: 'high',
      usedFallback: true,
      masterVersion: REEL_DIRECTOR_MASTER_VERSION,
      error: 'invalid preset',
    };
  }

  const template = REEL_MOTION_TEMPLATES[presetId];
  const notes = REEL_SHOT_NOTES_CS[presetId];

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      cameraPrompt: enforceFidelityPrompt(template, presetId),
      shotNotes: notes,
      presetApplied: presetId,
      estimatedStabilityScore: '0.99',
      hallucinationRisk: 'low',
      usedFallback: true,
      masterVersion: REEL_DIRECTOR_MASTER_VERSION,
    };
  }

  try {
    const raw = await callClaudeMessages(
      buildReelDirectorSystemPrompt(),
      JSON.stringify(
        buildReelDirectorUserPayload({
          preset: presetId,
          roomType,
          style: style || undefined,
          imageUrl,
        }),
      ),
      true,
    );
    const cleaned = String(raw)
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    const safe = sanitizeDirectorResult(parsed, presetId);
    return {
      ...safe,
      masterVersion: REEL_DIRECTOR_MASTER_VERSION,
    };
  } catch (err) {
    console.warn('[reelDirector] v3 fallback:', err.message);
    return {
      cameraPrompt: enforceFidelityPrompt(template, presetId),
      shotNotes: notes,
      presetApplied: presetId,
      estimatedStabilityScore: '0.99',
      hallucinationRisk: 'low',
      usedFallback: true,
      masterVersion: REEL_DIRECTOR_MASTER_VERSION,
      rejectReason: 'claude_error',
    };
  }
}

export { REEL_DIRECTOR_MASTER_VERSION, REEL_PRESET_IDS, REEL_MOTION_TEMPLATES };
