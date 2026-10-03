/**
 * Radar odpověď pro AI chat — okamžitě z cache, bez čekání na Apify.
 * Při Apify 403 / prázdné cache: transparentní fallback (historický medián + datum).
 */

import { loadRadarListingsForScan, getListingCacheMeta } from './radarCacheStore.js';
import { passesFsboFilter } from './listingAgency.js';
import { deduplicateListings } from './deduplicator.js';
import {
  queueBackgroundEnrich,
  isApifyQuotaCoolingDown,
  getApifyQuotaCooldownMs,
} from './radarBackgroundEnrich.js';
import { resolveRegionFromChat, inferPropertyTypeFromChat, resolvePlaceLabelFromChat } from '../lib/chatIntent.js';
import {
  referencesContextualLocality,
  resolveLocalityFromChatHistory,
  filterListingsByPlace,
  looksLikeMarketSearch,
} from '../lib/chatContextLocality.js';
import { foldCzechText, mentionsPlace } from '../lib/chatIntent.js';
import { buildBrokerMarketBrief, medianPrice } from './brokerMarketAnalysis.js';

function resolveContextualPlaceForRadar(message, history) {
  const raw = String(message || '').trim();
  if (!raw) return null;
  if (referencesContextualLocality(raw)) {
    return resolveLocalityFromChatHistory(history);
  }
  if (looksLikeMarketSearch(raw) && !mentionsPlace(foldCzechText(raw))) {
    return resolveLocalityFromChatHistory(history);
  }
  return null;
}

function quickScore(listing) {
  let score = 35;
  const reasons = [];
  if (!listing.isAgencyListing) {
    score += 15;
    reasons.push('soukromník');
  }
  if (listing.source === 'bazos') {
    score += 25;
    reasons.push('Bazoš');
  } else if (listing.source === 'bezrealitky') {
    score += 20;
    reasons.push('Bezrealitky');
  }
  if (listing.isAgencyListing && (listing.daysOnPortal ?? 0) >= 90) {
    score += 15;
    reasons.push('ležák u RK');
  }
  return { score: Math.min(100, score), reasons };
}

function fmtCacheDate(iso) {
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

function fmtPrice(n) {
  if (!n || !Number.isFinite(n)) return null;
  return `${new Intl.NumberFormat('cs-CZ').format(Math.round(n))} Kč`;
}

function liveDataDisclaimer({ apifyBlocked, meta, cacheEmpty }) {
  const when = fmtCacheDate(meta?.newestAt);
  if (apifyBlocked) {
    return (
      `⚠️ **Aktuální živá data z inzerce nejsou dostupná** (Apify limit / scrapování pozastaveno). ` +
      (when
        ? `Pracuji s **historickou cache lokality z ${when}**.`
        : `V cache zatím nemám použitelný snapshot — nemohu vymýšlet ceny.`)
    );
  }
  if (cacheEmpty) {
    return (
      `⚠️ **Aktuální živá data z inzerce nejsou dostupná** (cache prázdná). ` +
      `Obnova portálů může běžet na pozadí — nebo je scrapování dočasně omezené.`
    );
  }
  if (meta?.ageMin != null && meta.ageMin >= 12 * 60) {
    return (
      `ℹ️ Živý scrape teď neběží / data jsou starší. ` +
      `Opírám se o cache` +
      (when ? ` z **${when}**` : '') +
      `.`
    );
  }
  return null;
}

/**
 * @returns {{ brief: string, region: string, propertyType: string, leads: object[], cacheEmpty: boolean, dataSource: string, cacheAsOf: string|null, apifyBlocked: boolean }}
 */
export async function runRadarMarketBrief(message, { maxListings = 8, history = [] } = {}) {
  const contextualPlace = resolveContextualPlaceForRadar(message, history);

  const region = resolveRegionFromChat(contextualPlace || message);
  const propertyType = inferPropertyTypeFromChat(message);
  const apifyBlocked = isApifyQuotaCoolingDown();
  const meta = await getListingCacheMeta(region, propertyType).catch(() => ({
    count: 0,
    newestAt: null,
    ageMin: null,
  }));

  let cached = await loadRadarListingsForScan(region, propertyType);
  if (cached.length < 3 && !apifyBlocked) {
    queueBackgroundEnrich(region, propertyType, { reason: 'chat_query' }).catch(() => {});
  }

  const raw = deduplicateListings(cached);
  let listings = raw.filter((l) => passesFsboFilter(l, { fsboOnly: true, includeStaleAgency: false }));

  if (contextualPlace) {
    const filtered = filterListingsByPlace(listings, contextualPlace);
    if (filtered.length) listings = filtered;
  }

  listings = listings
    .map((l) => ({ ...l, ai: quickScore(l) }))
    .sort((a, b) => (b.ai?.score || 0) - (a.ai?.score || 0))
    .slice(0, maxListings);

  const placeLabel = contextualPlace || resolvePlaceLabelFromChat(message, region);
  const cacheEmpty = cached.length === 0;
  const disclaimer = liveDataDisclaimer({ apifyBlocked, meta, cacheEmpty });
  const cacheAsOf = meta?.newestAt || null;

  if (!listings.length) {
    const histMedian = medianPrice(raw);
    const cooldownH = Math.max(1, Math.round(getApifyQuotaCooldownMs() / 3_600_000));
    let brief =
      `**${placeLabel} — tržní situace (${propertyType})**\n\n` +
      (disclaimer ? `${disclaimer}\n\n` : '');

    if (histMedian) {
      brief +=
        `Z dostupného historického vzorku (${raw.length} inzerátů v širší cache) ` +
        `je orientační medián nabídek **${fmtPrice(histMedian)}**. ` +
        `Neberte to jako živý trh — ověřte po obnově portálů.\n\n`;
    } else {
      brief +=
        `Nemám v cache použitelný medián pro tuto lokalitu. ` +
        `**Nevymýšlím ceny** — počkejte na obnovu dat nebo otevřete Radar.\n\n`;
    }

    brief +=
      `**Co teď:** Záložka **Radar příležitostí** → **Obnovit / Skenovat**.` +
      (apifyBlocked
        ? ` Apify je dočasně v limitu (~${cooldownH} h cooldown) — po navýšení kreditu/resetu limitu se scrapování znovu spustí.`
        : ` Uvidíte progress a stav cache.`) +
      `\n\n_Jedna konkrétní adresa/parcela = GeoPas (katastr), ne Radar._`;

    return {
      region,
      propertyType,
      leads: [],
      cacheEmpty,
      dataSource: apifyBlocked ? 'historical_unavailable_live' : 'cache_empty',
      cacheAsOf,
      apifyBlocked,
      brief,
    };
  }

  let brief = buildBrokerMarketBrief(listings, {
    placeLabel,
    region,
    propertyType,
    totalInCache: cached.length,
    cacheAsOf,
    liveUnavailable: Boolean(apifyBlocked || (meta?.ageMin != null && meta.ageMin >= 12 * 60)),
  });

  if (disclaimer) {
    brief = `${disclaimer}\n\n${brief}`;
  }

  return {
    region,
    propertyType,
    leads: listings,
    cacheEmpty: false,
    dataSource: apifyBlocked ? 'historical_cache' : 'radar_cache',
    cacheAsOf,
    apifyBlocked,
    brief,
  };
}
