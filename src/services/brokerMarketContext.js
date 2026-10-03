/**
 * Aktuální tržní kontext pro system prompt chatu (Radar cache).
 */

import { getListingCacheMeta } from './radarCacheStore.js';
import { isApifyQuotaCoolingDown, getApifyQuotaCooldownMs } from './radarBackgroundEnrich.js';

const DEFAULT_REGIONS = ['Moravskoslezský', 'Praha', 'Jihomoravský'];

function fmtWhen(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('cs-CZ', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso).slice(0, 16);
  }
}

export async function buildMarketContextForPrompt() {
  const lines = ['Aktuální data z Radar cache (live při startu konverzace):'];
  let any = false;
  const apifyBlocked = isApifyQuotaCoolingDown();

  if (apifyBlocked) {
    const h = Math.max(1, Math.round(getApifyQuotaCooldownMs() / 3_600_000));
    lines.push(
      `- ⚠️ **Živý scraping (Apify) je nedostupný** (limit/cooldown ~${h} h). ` +
        `U market_scan vždy přiznej: pracuješ s historickou cache a uveď datum snapshotu — nevymýšlej ceny.`,
    );
  }

  for (const region of DEFAULT_REGIONS) {
    for (const propertyType of ['byty']) {
      try {
        const meta = await getListingCacheMeta(region, propertyType);
        if (meta.count > 0) {
          any = true;
          const when = fmtWhen(meta.newestAt);
          lines.push(
            `- **${region}** (${propertyType}): ${meta.count} inzerátů v cache` +
              (when ? `, snapshot ${when}` : '') +
              (meta.ageMin != null ? ` (stáří ~${meta.ageMin} min)` : ''),
          );
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (!any) {
    lines.push(
      '- Cache je prázdná — u tržních dotazů **nepíš generickou chybu**; řekni transparentně, že živá data nejsou, a nabídni Radar po obnově.',
    );
  }

  lines.push('');
  lines.push(
    'Pro trh/investice/porovnání nabídek používej intent **market_scan** a data z Radar cache — ne GeoPas.',
  );
  lines.push(
    'GeoPas jen pro konkrétní adresu nebo parcelu (katastr, záplavy, vlastník).',
  );

  return lines.join('\n');
}
