/**
 * Cost model for Makio promo video (< 4 Kč / video target).
 * 1 Kč ≈ 0.043 USD (configurable).
 */

const CZK_PER_USD = Number(process.env.PROMO_CZK_PER_USD || 23.5);

export const PROMO_MAX_COST_CZK = Number(process.env.PROMO_VIDEO_MAX_COST_CZK || 4);

/** Estimated USD costs (fal list prices, approximate). */
export const UNIT_COSTS_USD = {
  wanPerSec: 0.05,
  klingPerSec: 0.07,
  hailuoFast6s: 0.19,
  elevenLabsPer1kChars: 0.18,
  ffmpegKenBurns: 0,
  remotionPreview: 0,
};

export function usdToCzk(usd) {
  return Math.round(Number(usd) * CZK_PER_USD * 100) / 100;
}

/**
 * @param {{ droneProvider?: string, droneSeconds?: number, scriptChars?: number }} opts
 */
export function estimatePromoCostCzk(opts = {}) {
  const droneProvider = String(opts.droneProvider || process.env.PROMO_DRONE_PROVIDER || 'wan').toLowerCase();
  const droneSeconds = Math.max(0, Number(opts.droneSeconds ?? process.env.PROMO_DRONE_SECONDS ?? 2.5) || 2.5);
  const scriptChars = Math.max(0, Number(opts.scriptChars || 420) || 420);

  let droneUsd = 0;
  if (droneProvider === 'kling') droneUsd = UNIT_COSTS_USD.klingPerSec * droneSeconds;
  else if (droneProvider === 'hailuo' || droneProvider === 'hailuo_fast') {
    droneUsd = (UNIT_COSTS_USD.hailuoFast6s / 6) * droneSeconds;
  } else if (droneProvider === 'none' || droneProvider === 'mock') droneUsd = 0;
  else droneUsd = UNIT_COSTS_USD.wanPerSec * droneSeconds;

  const ttsUsd = (scriptChars / 1000) * UNIT_COSTS_USD.elevenLabsPer1kChars;
  const totalUsd = droneUsd + ttsUsd;
  const totalCzk = usdToCzk(totalUsd);

  return {
    currency: 'CZK',
    maxBudgetCzk: PROMO_MAX_COST_CZK,
    withinBudget: totalCzk <= PROMO_MAX_COST_CZK + 0.05,
    totalCzk,
    totalUsd: Math.round(totalUsd * 1000) / 1000,
    breakdown: {
      drone: { provider: droneProvider, seconds: droneSeconds, czk: usdToCzk(droneUsd) },
      voiceover: { chars: scriptChars, czk: usdToCzk(ttsUsd) },
      kenBurns: { czk: 0 },
      compose: { czk: 0 },
    },
  };
}

/** Pick cost-safe drone length so estimate stays under budget. */
export function resolveDroneSecondsForBudget({ droneProvider, scriptChars } = {}) {
  const provider = String(droneProvider || process.env.PROMO_DRONE_PROVIDER || 'wan').toLowerCase();
  let seconds = Number(process.env.PROMO_DRONE_SECONDS || 2.5) || 2.5;
  for (let s = seconds; s >= 1.5; s -= 0.25) {
    const est = estimatePromoCostCzk({ droneProvider: provider, droneSeconds: s, scriptChars });
    if (est.withinBudget) return s;
  }
  return 0; // skip AI drone — Ken Burns only
}
