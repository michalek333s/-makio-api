/**
 * Radar — multiportál:
 *   POST /scan    → Sreality REST (~1–2 s) + deduplikace + cache
 *   POST /enrich  → Apify async (Sreality + Bezrealitky + Bazoš) — cron / interní volání
 *   GET  /status/:runId → stav Apify běhu
 */

import { Router } from 'express';
import { LIMITS } from '../config/limits.js';
import { assertMaxLen } from '../lib/requestValidation.js';
import {
  fetchSrealityDirect,
  fetchSrealityGalleryUrlsByHash,
  REGION_IDS,
} from '../services/sreality.js';
import { deduplicateListings } from '../services/deduplicator.js';
import { getRunStatus } from '../services/apify.js';
import { enrichListingsWithRadarAi, scoreRadarLeadWithGemini } from '../services/radarAiScore.js';
import { filterListingsForMode, isAcquisitionViable } from '../lib/listingFilters.js';
import { filterListingsByRegion } from '../lib/radarRegions.js';
import {
  loadRadarListingsForScan,
  getRadarCacheStats,
  loadScanResult,
  storeScanResult,
  shouldSkipLiveSreality,
} from '../services/radarCacheStore.js';
import { attachCrmMatches } from '../services/radarCrmMatch.js';
import { pullEnrichRuns } from '../services/radarEnrichPull.js';
import { pullLatestApifyIntoCache } from '../services/apifyLastRun.js';
import { verifyAgencySignalsViaSrealityDetail } from '../services/radarAgencyVerify.js';
import {
  queueBackgroundEnrich,
  getEnrichStatus,
} from '../services/radarBackgroundEnrich.js';
import { attachRadarValidation, radarValidationStats } from '../services/radarValidate.js';
import { generateRadarColdCall } from '../services/radarColdCall.js';
import { getMemoryBlacklist } from '../services/radarIngest.js';
import { getRadarPollConfig, describeRadarPollConfig } from '../services/radarPollConfig.js';
import { getDemoRadarListings, DEMO_RADAR_WARNING, isDemoListing, isRadarDemoFallbackEnabled, stripDemoListings } from '../data/radarDemoListings.js';
import { loadAgencyReferencesForMatch, persistValidatedListings } from '../services/radarV2Store.js';
import { collectNearbyAgencyReferences, isPostgisMatchEnabled } from '../services/radarPostgisMatch.js';
import { finishNormalizedListing, localityToString } from '../lib/radarNormalize.js';
import { calculatePhashes } from '../services/radarPHash.js';
import { radarScanMemoryCache, invalidateRadarScanMemory } from '../services/radarScanMemory.js';

/** pHash fotek jen když RADAR_HASH_IMAGES=1 — stahování je drahé, cap ~8 inzerátů. */
async function hashListingImagesCapped(listings, max = 8) {
  if (!Array.isArray(listings) || listings.length === 0) return listings;
  const out = [];
  let used = 0;
  for (const listing of listings) {
    if (used >= max || listing?.photoPHash || (listing?.imageHashes || []).length) {
      out.push(listing);
      continue;
    }
    const urls = listing.imageUrls || listing.image_urls || [];
    if (!urls.length) {
      out.push(listing);
      continue;
    }
    used += 1;
    const hashes = await calculatePhashes(urls, { max: 3 });
    out.push(hashes.length ? { ...listing, photoPHash: hashes[0], imageHashes: hashes } : listing);
  }
  return out;
}

const router = Router();

const CACHE_TTL_MS = 30 * 60 * 1000;

function quickScore(listing, medianPrice) {
  if (listing.isAgencyListing) {
    const days = listing.daysOnPortal ?? 0;
    if (days < 90) {
      return {
        score: 0,
        label: 'Zastoupeno RK',
        reasons: [
          listing.agencyName
            ? `Nabízí ${listing.agencyName} — aktivní smlouva s konkurencí`
            : 'Inzerát od realitní kanceláře — náběr nevhodný',
        ],
        crmMatch: null,
        draftMessage: '',
      };
    }
  }

  let score = 35;
  const reasons = [];

  if (listing.isAgencyListing && (listing.daysOnPortal ?? 0) >= 90) {
    score += 20;
    reasons.push(
      `Ležák u RK (${listing.daysOnPortal} dní) — možný náběr po skončení smlouvy`,
    );
  }

  if (listing.fsboSignal || !listing.isAgencyListing) {
    score += 8;
    if (listing.source !== 'bazos' && listing.source !== 'bezrealitky') {
      reasons.push('Soukromník / bez RK signálu');
    }
  }

  if (listing.source === 'bazos') {
    score += 35;
    reasons.push('Soukromý inzerát na Bazoši — vysoký náběrový potenciál');
  } else if (listing.source === 'bezrealitky') {
    score += 30;
    reasons.push('Soukromý inzerát na Bezrealitky — přímý kontakt s majitelem');
  } else if (listing.source === 'facebook' || listing.source === 'facebook_marketplace') {
    score += 32;
    reasons.push('Facebook Marketplace — často přímý kontakt s majitelem');
  }

  if (listing.multiPortalBonus) {
    score += 10;
    const portals = [...new Set(listing.foundOnPortals || [])].filter(Boolean);
    const portalsStr = portals.join(', ');
    reasons.push(
      `Inzerát na ${portals.length || listing.foundOnPortals?.length || 0} portálech (${portalsStr}) — majitel aktivně hledá řešení`,
    );
  }

  if (medianPrice && listing.price) {
    const diff = Math.round(((medianPrice - listing.price) / medianPrice) * 100);
    if (diff >= 15) {
      score += 20;
      reasons.push(`Cena ${diff} % pod mediánem — výrazně podhodnoceno`);
    } else if (diff >= 8) {
      score += 12;
      reasons.push(`Cena ${diff} % pod mediánem lokality`);
    } else if (diff < -15) {
      score -= 10;
    }
  }

  if (listing.priceChanged) {
    score += 15;
    reasons.push('Cena byla snížena — majitel je flexibilní');
  }
  if (listing.isNew) {
    score += 8;
    reasons.push('Nový inzerát — příležitost oslovit jako první');
  }
  if (!listing.floorArea) {
    score += 5;
    reasons.push('Nekompletní prezentace — makléř přidá hodnotu');
  }

  score = Math.min(100, Math.max(0, score));

  const loc = localityToString(listing.locality).split(',')[0] || 'vaši nemovitost';
  let draftMessage;
  if (listing.source === 'bazos') {
    draftMessage = `Dobrý den, narazil jsem na váš inzerát na Bazoši. Specializuji se na ${loc} a mám databázi kupujících hledajících právě tuto lokalitu. Byl/a byste ochoten/na si krátce pohovořit?`;
  } else if (listing.source === 'bezrealitky') {
    draftMessage = `Dobrý den, zaujala mě vaše nabídka v ${loc}. Mám aktivní poptávky od kupujících pro tuto oblast a myslím, že bych vám mohl/a pomoci prodat za lepší cenu. Kdy byste měl/a čas na hovor?`;
  } else if (listing.source === 'facebook' || listing.source === 'facebook_marketplace') {
    draftMessage = `Dobrý den, viděl/a jsem váš inzerát na Facebooku v ${loc}. Specializuji se na prodej v této lokalitě — rád/a bych vám pomohl/a s prodejem. Máte chvíli na krátký hovor?`;
  } else {
    draftMessage = `Dobrý den, sleduji realitní trh v ${loc}. Rád bych vám pomohl s prodejem — mám databázi aktivních kupujících. Smím zavolat?`;
  }

  return {
    score,
    label:
      score >= 75 ? 'Vysoký potenciál' : score >= 50 ? 'Střední potenciál' : 'Nízký potenciál',
    reasons: reasons.length ? reasons : ['Standardní inzerát'],
    crmMatch: null,
    draftMessage,
  };
}

function safeQuickScore(listing, medianPrice) {
  try {
    return quickScore(listing, medianPrice);
  } catch (e) {
    console.warn('[Radar] quickScore', listing?.listingId, e.message);
    return {
      score: 0,
      label: 'Nízký potenciál',
      reasons: ['Skóre se nepodařilo spočítat'],
      crmMatch: null,
      draftMessage: '',
    };
  }
}

function resolveRegion(body) {
  if (body.region && String(body.region).trim()) {
    return String(body.region).trim();
  }
  const regions = body.regions;
  if (Array.isArray(regions) && regions.length > 0) {
    return String(regions[0]).trim();
  }
  return 'Moravskoslezský';
}

function stripListingForApi(listing) {
  if (!listing || typeof listing !== 'object') return listing;
  const { _raw, ...rest } = listing;
  return rest;
}

function compactClients(clients) {
  if (!Array.isArray(clients)) return [];
  return clients
    .filter((c) => c && c.name)
    .map((c) => ({
      id: c.id,
      name: c.name,
      budget: c.budget,
      interest: c.interest,
      address_property_buy: c.address_property_buy,
      priority: c.priority,
    }))
    .slice(0, 200);
}

function medianFromListings(listings) {
  const prices = listings
    .map((l) => l.price)
    .filter((p) => p && p > 100_000)
    .sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
}

async function buildRadarScan({
  region,
  propertyType,
  offerType,
  maxPrice,
  minArea,
  maxListings,
  useAiOnScan,
  fsboOnly,
  includeStaleAgency,
  scanMode = 'market',
  clients,
}) {
  const perPage = Math.min(maxListings, 100);

  let cachedListings = await loadRadarListingsForScan(region, propertyType);
  cachedListings = stripDemoListings(cachedListings);

  // Stará demo cache se nesmí tvářit jako živý trh, pokud demo není povoleno
  if (!isRadarDemoFallbackEnabled() && cachedListings.length === 0) {
    // already stripped
  }

  if (cachedListings.length === 0) {
    try {
      const pulled = await pullLatestApifyIntoCache({ region, propertyType });
      if (pulled.ok) {
        cachedListings = stripDemoListings(
          await loadRadarListingsForScan(region, propertyType),
        );
        console.log(`[Radar] Apify last-run: ${pulled.total} inzerátů`);
      }
    } catch (e) {
      console.warn('[Radar] Apify last-run:', e.message);
    }
  }

  let demoWarning = null;
  let cacheEmpty = false;

  if (cachedListings.length === 0) {
    const demo = getDemoRadarListings(region);
    if (demo.length > 0) {
      // Demo se NEUKLÁDÁ do sdílené cache — jen do odpovědi tohoto scanu
      cachedListings = demo;
      demoWarning = DEMO_RADAR_WARNING;
      console.log(`[Radar] Demo fallback (ephemeral): ${demo.length} inzerátů`);
    } else {
      cacheEmpty = true;
    }
  } else if (cachedListings.some(isDemoListing)) {
    // Defenzivní: pokud by se demo přece jen dostalo do loadu
    if (isRadarDemoFallbackEnabled()) {
      demoWarning = DEMO_RADAR_WARNING;
    } else {
      cachedListings = stripDemoListings(cachedListings);
      cacheEmpty = cachedListings.length === 0;
    }
  }

  let srealityResult = { listings: [], totalCount: 0, source: 'sreality_direct' };
  let srealityWarning = null;
  const cacheOnly = process.env.RADAR_CACHE_ONLY !== '0';
  const minCache = Number(process.env.RADAR_CACHE_MIN_LISTINGS || 3);
  // Dřív: skip jen při cache ≥ min → při prázdné cache se volalo přímé API → 404 spam
  const skipLive =
    !demoWarning &&
    (shouldSkipLiveSreality(cachedListings.length) ||
      (cachedListings.length >= minCache && cacheOnly));

  if (skipLive) {
    if (demoWarning) {
      srealityWarning = demoWarning;
    } else if (cachedListings.length > 0) {
      srealityWarning = `Scan z cache (${cachedListings.length} inzerátů) — okamžitý výsledek.`;
    } else {
      srealityWarning =
        'Cache prázdná — přímé Sreality API z serveru nefunguje (404). Spusťte „Obnovit cache“ (Apify) nebo počkejte na background enrich.';
    }
    console.log(`[Radar] Skip live Sreality (${cachedListings.length} inzerátů v cache)`);
  } else {
    try {
      srealityResult = await fetchSrealityDirect({
        region,
        propertyType,
        offerType,
        maxPrice,
        minArea,
        perPage,
      });
    } catch (err) {
      const status = err.statusCode || null;
      // 404 = Sreality blokuje datacenter IP (ne „nenalezeno“ v Makiu)
      if (status === 404) {
        console.warn(
          '[Radar] Sreality přímé API vrací 404 (blokace z serveru) — používám jen cache/Apify. Nastavte RADAR_SREALITY_DIRECT=0.',
        );
      } else {
        console.warn('[Radar] Sreality nedostupné:', err.message);
      }
      srealityWarning =
        status === 404
          ? 'Sreality přímé API z tohoto serveru blokuje (404). Radar jede z Apify cache.'
          : status === 403 || status === 429
            ? 'Sreality dočasně omezuje přístup (403/429). Scan pokračuje z cache.'
            : cachedListings.length > 0
              ? 'Sreality live API nedostupné — scan běží z cache (Apify).'
              : null;
      if (!cachedListings.length && !cacheOnly && status !== 404) {
        const fallbackErr = new Error(
          srealityWarning ||
            'Cache prázdná — žádná živá data. Spusťte „Obnovit cache“ nebo počkejte na background enrich.',
        );
        fallbackErr.statusCode = status;
        fallbackErr.code = 'SREALITY_UNAVAILABLE';
        throw fallbackErr;
      }
    }
  }

  if (cacheEmpty && !demoWarning && cachedListings.length === 0 && !srealityResult.listings?.length) {
    srealityWarning =
      srealityWarning ||
      `Cache prázdná pro ${region} / ${propertyType}. ` +
        'Přímé Sreality API z serveru vrací 404 (nutný residential proxy / Apify). ' +
        'Pokud máte Apify dataset-locked (měsíční limit), nové scrapování neběží — navýšte plán nebo počkejte na reset limitu, pak „Obnovit cache“.';
  }

  const allRaw = filterListingsByRegion(
    deduplicateListings([...cachedListings, ...srealityResult.listings])
      .map((l) => finishNormalizedListing(l))
      .filter((l) => {
        if (maxPrice != null && Number.isFinite(Number(maxPrice)) && l.price && l.price > Number(maxPrice)) {
          return false;
        }
        if (minArea != null && Number.isFinite(Number(minArea)) && l.floorArea && l.floorArea < Number(minArea)) {
          return false;
        }
        return true;
      }),
    region,
  );

  const effectiveMode =
    scanMode === 'acquisition' || (fsboOnly && scanMode !== 'market') ? 'acquisition' : 'market';

  let agencyVerifyStats = null;
  const shouldVerify =
    process.env.RADAR_DETAIL_VERIFY !== '0' &&
    (effectiveMode === 'acquisition' || process.env.RADAR_DETAIL_VERIFY_MARKET === '1');

  let listingsForStats = allRaw;
  if (shouldVerify) {
    const verified = await verifyAgencySignalsViaSrealityDetail(allRaw);
    listingsForStats = verified.listings;
    agencyVerifyStats = verified.stats;
  }

  let extraReferences = [];
  try {
    extraReferences = await loadAgencyReferencesForMatch({ region });
  } catch (e) {
    console.warn('[Radar v2] load references:', e.message);
  }

  if (isPostgisMatchEnabled()) {
    try {
      const nearby = await collectNearbyAgencyReferences(listingsForStats);
      if (nearby.length) extraReferences = [...nearby, ...extraReferences];
    } catch (e) {
      console.warn('[Radar v2] PostGIS nearby:', e.message);
    }
  }

  if (process.env.RADAR_HASH_IMAGES === '1') {
    listingsForStats = await hashListingImagesCapped(listingsForStats);
  }

  listingsForStats = attachRadarValidation(listingsForStats, {
    blacklist: getMemoryBlacklist(),
    extraReferences,
  });

  const radarStatusCounts = radarValidationStats(listingsForStats);

  const statsBeforeFilter = {
    totalRaw: listingsForStats.length,
    fromCache: cachedListings.length,
    fromSreality: srealityResult.listings.length,
    agencyCount: listingsForStats.filter((l) => l.isAgencyListing).length,
    fsboCount: listingsForStats.filter((l) => !l.isAgencyListing).length,
    agencyVerify: agencyVerifyStats,
    radarStatusCounts,
    bySource: listingsForStats.reduce((acc, l) => {
      const s = l.source || 'unknown';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {}),
  };

  let listings;
  if (effectiveMode === 'acquisition') {
    listings = filterListingsForMode(listingsForStats, 'acquisition', {
      includeStaleAgency: includeStaleAgency !== false,
    });
  } else {
    listings = listingsForStats;
  }

  const medianPrice = medianFromListings(listingsForStats);

  // Skóre jednou → CRM → řazení → teprve pak limit (CRM match nesmí spadnout za 200)
  let scored;
  const preScored = listings.map((l) => {
    const ai = safeQuickScore(l, medianPrice);
    return { ...l, ai, aiMeta: { source: 'heuristic' }, _sortScore: Number(ai?.score) || 0 };
  });

  const aiCandidates = preScored.filter(
    (l) => !l.isAgencyListing || (l.daysOnPortal ?? 0) >= 90,
  );

  if (
    useAiOnScan &&
    process.env.GEMINI_API_KEY &&
    process.env.RADAR_AI_DISABLE !== '1' &&
    aiCandidates.length > 0
  ) {
    const enriched = await enrichListingsWithRadarAi(aiCandidates, medianPrice, safeQuickScore);
    const scoredIds = new Set(enriched.map((l) => String(l.listingId)));
    const rest = preScored.filter((l) => !scoredIds.has(String(l.listingId)));
    scored = [
      ...enriched.map((l) => ({ ...l, _sortScore: Number(l.ai?.score) || 0 })),
      ...rest,
    ];
  } else {
    scored = preScored;
  }

  scored = scored
    .map((l) => {
      const withCrm = attachCrmMatches(stripListingForApi(l), clients);
      const { _sortScore, ...rest } = withCrm;
      return {
        ...rest,
        _sortScore: _sortScore ?? (Number(rest.ai?.score) || 0),
        _crmScore: rest.crmMatches?.[0]?.score || 0,
      };
    })
    .sort((a, b) => {
      if (b._crmScore !== a._crmScore) return b._crmScore - a._crmScore;
      return b._sortScore - a._sortScore;
    });

  if (effectiveMode === 'acquisition') {
    scored = scored.filter(isAcquisitionViable);
  }

  scored = scored
    .slice(0, maxListings)
    .map(({ _sortScore, _crmScore, ...rest }) => rest);

  const portals = [...new Set(scored.flatMap((l) => l.foundOnPortals || [l.source]))];
  const sourceStats = scored.reduce((acc, l) => {
    const s = l.source || 'unknown';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  persistScanPool(listingsForStats, region, demoWarning);

  const cacheOnlySuccess =
    Boolean(skipLive) && !demoWarning && cachedListings.length > 0 && !srealityWarning?.includes('prázdná');

  return {
    leads: scored,
    total: scored.length,
    totalOnMarket: srealityResult.totalCount,
    medianPrice,
    region,
    propertyType,
    portals,
    sourceStats,
    stats: statsBeforeFilter,
    scanMode: effectiveMode,
    fsboOnly: effectiveMode === 'acquisition',
    includeStaleAgency,
    srealityWarning,
    srealityOk: cacheOnlySuccess || (!srealityWarning && !demoWarning),
    cacheOnly: Boolean(skipLive) && !demoWarning,
    demoData: Boolean(demoWarning) || (scored.length > 0 && scored.every(isDemoListing)),
    demoWarning,
    cacheEmpty: Boolean(cacheEmpty) && scored.length === 0,
    radarPipeline: {
      antiRk: true,
      liveScrape: getRadarPollConfig().enabled,
      coverageNote: describeRadarPollConfig(),
    },
  };
}

function persistScanPool(listings, region, demoWarning) {
  if (demoWarning) return;
  persistValidatedListings(listings, { region }).catch((e) => {
    console.warn('[Radar v2] persist scan:', e.message);
  });
}

router.post('/scan', async (req, res, next) => {
  try {
    const {
      propertyType = 'byty',
      offerType = 'prodej',
      maxPrice = null,
      minArea = null,
      maxListings = 200,
      fsboOnly = false,
      includeStaleAgency = true,
      scanMode: bodyScanMode,
      clients: rawClients = [],
    } = req.body || {};

    let scanMode = 'market';
    if (bodyScanMode === 'acquisition' || bodyScanMode === 'market') {
      scanMode = bodyScanMode;
    } else if (req.body?.fsboOnly === true) {
      scanMode = 'acquisition';
    }

    const region = resolveRegion(req.body);
    assertMaxLen(region, LIMITS.RADAR_REGION_NAME_MAX, 'region');

    if (!REGION_IDS[region]) {
      return res.status(400).json({
        error: `Neznámý region „${region}“. Doplňte mapování v services/sreality.js.`,
      });
    }

    const allowedTypes = new Set(['byty', 'domy', 'pozemky']);
    if (!allowedTypes.has(propertyType)) {
      return res.status(400).json({ error: 'propertyType musí být: byty, domy nebo pozemky.' });
    }

    let ml = Number(maxListings);
    if (!Number.isFinite(ml)) ml = 200;
    ml = Math.min(Math.max(Math.floor(ml), 1), LIMITS.RADAR_MAX_LISTINGS);

    const useAiOnScan =
      process.env.RADAR_AI_ON_SCAN === '1' || req.body?.useAiScoring === true;

    const clients = compactClients(rawClients);
    const cacheKey = `v3-${region}-${propertyType}-${offerType}-${maxPrice}-${minArea}-${ml}-${
      useAiOnScan ? 'ai' : 'fast'
    }-${scanMode}-${includeStaleAgency ? 'stale' : ''}`;
    const now = Date.now();
    const cached = radarScanMemoryCache.get(cacheKey);

    if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
      const leads = filterListingsByRegion(cached.data.leads || [], region).map((l) =>
        attachCrmMatches(l, clients),
      );
      return res.json({
        ...cached.data,
        leads,
        fromCache: true,
        cacheAgeMin: Math.round((now - cached.cachedAt) / 60_000),
        cacheLayer: 'memory',
      });
    }

    const persisted = await loadScanResult(cacheKey);
    if (persisted?.leads?.length) {
      const filteredLeads = filterListingsByRegion(persisted.leads, region);
      const leads = filteredLeads.map((l) => attachCrmMatches(l, clients));
      radarScanMemoryCache.set(cacheKey, {
        data: { ...persisted, leads: filteredLeads },
        cachedAt: now - (persisted.cacheAgeMin || 0) * 60_000,
      });
      return res.json({
        ...persisted,
        leads,
        fromCache: true,
        cacheLayer: persisted.cacheLayer || 'supabase',
      });
    }

    const startTime = Date.now();

    getEnrichStatus(region, propertyType)
      .then((st) => {
        if (st.needsRefresh) {
          return queueBackgroundEnrich(region, propertyType, { reason: 'scan_stale' });
        }
        return null;
      })
      .catch((e) => console.warn('[Radar] BG enrich trigger:', e.message));

    const built = await buildRadarScan({
      region,
      propertyType,
      offerType,
      maxPrice,
      minArea,
      maxListings: ml,
      useAiOnScan,
      fsboOnly: scanMode === 'acquisition',
      includeStaleAgency,
      scanMode,
      clients,
    });

    const elapsed = Date.now() - startTime;
    const enrichStatus = await getEnrichStatus(region, propertyType).catch(() => null);

    const result = {
      ...built,
      scannedAt: new Date().toISOString(),
      responseTimeMs: elapsed,
      radarAiScoring:
        useAiOnScan && process.env.GEMINI_API_KEY && process.env.RADAR_AI_DISABLE !== '1'
          ? 'gemini_batch'
          : 'heuristic_fast',
      crmClientsUsed: clients.length,
      cacheMeta: enrichStatus?.cache || null,
      enriching: enrichStatus?.job?.status === 'running' || enrichStatus?.needsRefresh === true,
      enrichJob: enrichStatus?.job || null,
    };

    radarScanMemoryCache.set(cacheKey, { data: { ...result, leads: built.leads.map(({ crmMatches, ...rest }) => ({ ...rest, crmMatches })) }, cachedAt: now });
    storeScanResult(
      cacheKey,
      { ...result, leads: built.leads.map(({ crmMatches, ...rest }) => ({ ...rest, crmMatches })) },
      { region, propertyType },
    ).catch((e) => console.warn('[Radar] scan cache write:', e.message));
    res.json(result);
  } catch (error) {
    if (error.code === 'SREALITY_UNAVAILABLE' || error.name === 'TimeoutError') {
      return res.status(503).json({
        error: error.message || 'Sreality API momentálně nedostupné. Zkuste za chvíli.',
        suggestion:
          'Nejdřív spusťte „Načíst portály“ (Apify: Sreality + Bezrealitky + Bazoš), pak znovu scan.',
      });
    }
    if (error.message?.includes('fetch failed')) {
      return res.status(503).json({
        error: 'Backend nemohl načíst data (síťová chyba). Zkuste scan znovu.',
        suggestion:
          'Pokud jste ještě nenačetli portály, klikněte „Načíst portály“. Supabase cache může být dočasně nedostupná.',
      });
    }
    next(error);
  }
});

/** Spustí enrich na pozadí — okamžitá odpověď, polling na serveru. */
router.post('/enrich', async (req, res, next) => {
  try {
    const {
      region: bodyRegion,
      propertyType = 'byty',
      force = false,
    } = req.body || {};
    const region = bodyRegion?.trim() || resolveRegion(req.body);

    if (!REGION_IDS[region]) {
      return res.status(400).json({
        error: `Neznámý region „${region}“ pro enrich.`,
      });
    }

    const allowedTypes = new Set(['byty', 'domy', 'pozemky']);
    if (!allowedTypes.has(propertyType)) {
      return res.status(400).json({ error: 'propertyType musí být: byty, domy nebo pozemky.' });
    }

    const result = await queueBackgroundEnrich(region, propertyType, {
      force: force === true,
      reason: 'api',
    });

    if (!result.queued && result.reason === 'cache_fresh') {
      return res.json({
        message: 'Cache je aktuální — scan je okamžitý.',
        ...result,
      });
    }

    if (!result.queued && result.alreadyRunning) {
      return res.json({
        message: 'Enrich už běží na pozadí.',
        ...result,
      });
    }

    // BG vrstva už salvovala last-run (quota / start fail)
    if (!result.queued && result.pulled?.ok) {
      invalidateRadarScanMemory(region, propertyType);
      return res.json({
        ok: true,
        message: result.pulled.message || 'Cache doplněna z posledního Apify běhu.',
        code: result.code || result.pulled.code || 'apify_last_run',
        ...result,
      });
    }

    if (!result.queued) {
      try {
        const pulled = await pullLatestApifyIntoCache({ region, propertyType });
        if (pulled.ok) {
          invalidateRadarScanMemory(region, propertyType);
          return res.json({
            message: pulled.message,
            ok: true,
            code: pulled.code || 'apify_last_run',
            pulled,
            ...result,
          });
        }
        return res.status(200).json({
          ok: false,
          code: pulled.code || result.code || 'APIFY_UNAVAILABLE',
          error:
            pulled.message ||
            'Enrich se nepodařilo spustit. Scan dál běží z existující cache.',
          pulled,
          ...result,
        });
      } catch (pullErr) {
        console.warn('[Radar enrich] last-run fallback:', pullErr.message);
      }
      return res.status(200).json({
        ok: false,
        code: result.code || 'APIFY_UNAVAILABLE',
        error:
          'Enrich se nepodařilo spustit (Apify limit nebo síť). Scan dál běží z existující cache.',
        ...result,
      });
    }

    res.json({
      message: 'Enrich běží na pozadí — scan použije cache, jakmile bude hotovo.',
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/enrich-status', async (req, res, next) => {
  try {
    const region = String(req.query.region || 'Moravskoslezský').trim();
    const propertyType = String(req.query.propertyType || 'byty').trim();
    const status = await getEnrichStatus(region, propertyType);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

router.get('/status/:runId', async (req, res, next) => {
  try {
    const info = await getRunStatus(req.params.runId);
    res.json(info);
  } catch (err) {
    next(err);
  }
});

/** Stáhne dokončené Apify běhy a uloží inzeráty do radar cache. */
router.post('/enrich-pull', async (req, res, next) => {
  try {
    const {
      srealityRunId,
      czRealityRunId,
      bazosRunId,
      facebookRunId,
      region: bodyRegion,
      propertyType = 'byty',
    } = req.body || {};
    const region = bodyRegion?.trim() || resolveRegion(req.body);

    if (!REGION_IDS[region]) {
      return res.status(400).json({ error: `Neznámý region „${region}“.` });
    }

    if (!srealityRunId && !czRealityRunId && !bazosRunId && !facebookRunId) {
      const pulled = await pullLatestApifyIntoCache({ region, propertyType });
      if (pulled.ok) {
        invalidateRadarScanMemory(region, propertyType);
        return res.json({
          ok: true,
          message: pulled.message,
          stored: pulled.stored,
          total: pulled.total,
          runId: pulled.runId,
          code: pulled.code,
        });
      }
      return res.json({
        ok: false,
        message: pulled.message,
        code: pulled.code,
        stored: 0,
      });
    }

    const result = await pullEnrichRuns({
      srealityRunId,
      czRealityRunId,
      bazosRunId,
      facebookRunId,
      region,
      propertyType,
    });

    if (result.pending) {
      return res.json({
        ok: false,
        message: 'Některé Apify běhy ještě běží — zkuste znovu za chvíli.',
        runs: result.runMeta,
        warnings: result.warnings,
      });
    }

    if (!result.ok) {
      return res.json({
        ok: false,
        message: result.message,
        runs: result.runMeta,
        warnings: result.warnings,
      });
    }

    if (!result.empty) {
      invalidateRadarScanMemory(region, propertyType);
    }
    res.json({
      ok: true,
      empty: Boolean(result.empty),
      stored: result.stored || 0,
      total: result.total || 0,
      region,
      propertyType,
      runs: result.runMeta,
      warnings: result.warnings,
      message: result.empty ? result.message : undefined,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/cache-stats', (_req, res) => {
  res.json(getRadarCacheStats());
});

/** Diagnostika struktury JSON ze Sreality — v produkci jen s RADAR_DEBUG=1 */
/** Doplnění fotek z detailu Sreality (stejné veřejné API, hash = listingId u sreality). */
router.get('/sreality-gallery/:hashId', async (req, res, next) => {
  try {
    const { hashId } = req.params;
    if (!hashId || String(hashId).length > 64) {
      return res.status(400).json({ error: 'Neplatný hash.' });
    }
    const imageUrls = await fetchSrealityGalleryUrlsByHash(hashId);
    res.json({ imageUrls });
  } catch (err) {
    next(err);
  }
});

router.get('/debug', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.RADAR_DEBUG !== '1') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const regionId = req.query.region ?? 14;

    const url = `https://www.sreality.cz/api/cs/v2/estates?category_main_cb=1&category_type_cb=1&locality_region_id=${regionId}&per_page=3&tms=${Date.now()}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Referer: 'https://www.sreality.cz/',
      },
    });

    const raw = await response.json();
    const firstEstate = raw?._embedded?.estates?.[0];

    res.json({
      status: response.status,
      totalResults: raw?.result_size,
      estatesReturned: raw?._embedded?.estates?.length,
      firstEstateKeys: firstEstate ? Object.keys(firstEstate) : [],
      nameStructure: firstEstate?.name,
      localityStructure: firstEstate?.locality,
      priceStructure: firstEstate?.price_czk,
      gpsStructure: firstEstate?.gps,
      linksStructure: firstEstate?._links ? Object.keys(firstEstate._links) : [],
      fullFirstEstate: firstEstate,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/leads', async (req, res) => {
  const region = String(req.query.region || 'Moravskoslezský');
  const propertyType = String(req.query.propertyType || 'byty');
  const listings = await loadRadarListingsForScan(region, propertyType);
  res.json({
    region,
    propertyType,
    total: listings.length,
    listings: listings.slice(0, 100),
    cache: getRadarCacheStats(),
  });
});

/**
 * Hloubkové AI hodnocení jednoho inzerátu (Gemini) — volat po výběru v detailu; scan zůstává rychlý.
 */
router.post('/score-lead', async (req, res, next) => {
  try {
    const { lead, medianPrice } = req.body || {};
    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'Chybí lead (objekt).' });
    }
    assertMaxLen(JSON.stringify(lead), LIMITS.RADAR_LEAD_JSON_MAX, 'lead');
    const mp =
      medianPrice != null && Number.isFinite(Number(medianPrice)) ? Number(medianPrice) : null;
    const { ai, aiMeta } = await scoreRadarLeadWithGemini(lead, mp, quickScore);
    const clients = compactClients(req.body?.clients || []);
    const enriched = attachCrmMatches({ ...lead, ai, aiMeta }, clients);
    res.json({ ai: enriched.ai, aiMeta: enriched.aiMeta, crmMatches: enriched.crmMatches });
  } catch (err) {
    next(err);
  }
});

/**
 * Cold-call / SMS skript (Gemini, hlas Nemia). Heuristika když klíč chybí.
 */
router.post('/cold-call', async (req, res, next) => {
  try {
    const { lead } = req.body || {};
    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'Chybí lead (objekt).' });
    }
    assertMaxLen(JSON.stringify(lead), LIMITS.RADAR_LEAD_JSON_MAX, 'lead');
    const result = await generateRadarColdCall(lead);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/pipeline', (_req, res) => {
  const poll = getRadarPollConfig();
  const persistOn =
    process.env.RADAR_V2_PERSIST !== '0' &&
    Boolean(String(process.env.SUPABASE_URL || '').trim() && String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
  res.json({
    antiRk: true,
    persist: persistOn,
    cacheOnly: poll.cacheOnly,
    liveScrape: poll.enabled,
    coverage: describeRadarPollConfig(),
    intervals: {
      bazosMs: poll.bazosMs,
      bezrealitkyMs: poll.bezrealitkyMs,
      srealityMs: poll.srealityMs,
    },
    proxyConfigured: Boolean(poll.proxyUrl),
    postgisMatch: isPostgisMatchEnabled(),
    hashImages: process.env.RADAR_HASH_IMAGES === '1',
    note:
      'Anti-RK filtr běží nad načtenými inzeráty (cache / Apify / vybraný kraj). Není to celostátní 24/7 inbox.',
  });
});

export default router;
