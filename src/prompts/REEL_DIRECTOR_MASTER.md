# Makio ReelDirector Engine v3.0

**Source of truth:** `reelDirectorMasterPrompt.js` → `buildReelDirectorSystemPrompt()`

## Goal
Convert `preset` + `roomType` (+ optional `style`) into a **≤40 word** English Image-to-Video camera prompt for Kling / Higgsfield / Runway Gen-3.

## Anti-hallucination
- Environment 100% rigid / static / frozen
- No object motion (curtains, fire, shadows)
- Camera-only gimbal motion
- Forbidden: morphing, transforming, changing, dynamic, evolving, magic, surreal, flowing, moving objects

## Presets
| ID | CZ | Motion |
|----|----|--------|
| `dolly_in` | Příbližení do prostoru | Slow linear Z-axis dolly push-in |
| `pan_right` | Pomalý posun vpravo | Horizontal pan/truck L→R |
| `orbit` | Jemný krouživý pohyb | Subtle arc, level horizon |
| `crane_up` | Přízemní výtah / Odhalení | Vertical pedestal low→eye |

## Output JSON
```json
{
  "cameraPrompt": "string (under 40 words)",
  "presetApplied": "dolly_in|pan_right|orbit|crane_up",
  "estimatedStabilityScore": "0.98"
}
```

## Sanitizer
Backend rejects prompts that are too long, miss `9:16`, miss rigid/static lock, or contain forbidden words → falls back to static `REEL_MOTION_TEMPLATES`.
