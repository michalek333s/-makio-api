/**
 * Sestavení analýzy nemovitosti pro API, chat a UI.
 */

import {
  isWsdpTestSampleParcel,
  sanitizeAnalysisWsdpTest,
} from '../lib/wsdpTestMode.js';

export function buildAnalysisResponse(geopasData, safetyScore) {
  const { property, parcel, flood, zoning, geology, amenities, fetchedAt } = geopasData;

  const scoreForPrice =
    safetyScore?.mode === 'amenities_only' || safetyScore?.isPartial
      ? 50
      : safetyScore.score;
  const basePrice = estimateBasePrice(property, scoreForPrice);
  const valuation = {
    optimistic: formatPrice(basePrice * 1.15),
    realistic: formatPrice(basePrice),
    pessimistic: formatPrice(basePrice * 0.88),
    method: 'heuristic',
    note:
      safetyScore?.mode === 'amenities_only' || safetyScore?.isPartial
        ? 'Orientační odhad (heuristika Kč/m²) — Safety Score je částečný/jen vybavenost, proto se do ceny nepromítá. Není znalecký posudek.'
        : 'Orientační odhad (heuristika Kč/m² podle regionu + Safety Score) — NENÍ znalecký posudek ani tržní cenová mapa. Pro obchod vždy ověřte srovnatelné prodeje.',
  };

  const liens = parcel?.liens ?? [];
  const hasExecution = liens.some((l) => l.type?.toLowerCase().includes('exekuc'));
  const hasMortgage = liens.some((l) => l.type?.toLowerCase().includes('zástavní'));
  const radonRisk = geology?.radon?.level ?? 'nezjištěno';
  const miningRisk = geology?.mining?.affected ?? false;

  const ownerAccess = geopasData.wsdpAccess || 'none';
  const wsdpHint = geopasData.geopasMeta?.wsdpHint;
  const wsdpError = geopasData.geopasMeta?.wsdpError;
  const isTestSample = isWsdpTestSampleParcel(parcel, ownerAccess);

  let owner =
    parcel?.owner ??
    (ownerAccess === 'credentials'
      ? '—'
      : ownerAccess === 'test'
        ? null
        : 'Vyžaduje WSDP přístup (GeoPas)');
  if (!parcel?.owner && wsdpError) {
    owner = `WSDP: ${wsdpError}`;
  }
  if (parcel?.owner && ownerAccess === 'credentials' && !isTestSample) {
    owner = parcel.owner;
  }

  let lv = parcel?.lv ?? '—';
  let owners =
    parcel?.raw?.owners?.map((o) => o.name).filter(Boolean) ||
    (parcel?.owner ? [parcel.owner.replace(/ \(ukázkové LV.*\)$/, '')] : []);
  let effectiveLiens = liens;
  let effectiveHasExecution = hasExecution;
  let effectiveHasMortgage = hasMortgage;

  if (isTestSample) {
    owner = null;
    lv = '—';
    owners = [];
    effectiveLiens = [];
    effectiveHasExecution = false;
    effectiveHasMortgage = false;
  }

  const ownerMessage = isTestSample
    ? 'Vlastník a LV nejsou v testovacím režimu WSDP — GeoPas vrací stejnou ukázkovou LV pro všechny parcely. Pro skutečné údaje aktivujte produkční WSDP (GEOPAS_WSDP_TEST=false + login/heslo od GeoPas) nebo ověřte ručně na nahlizeni.cuzk.cz.'
    : ownerAccess === 'none'
      ? 'Pro jméno vlastníka a číslo LV je potřeba WSDP přístup od GeoPas.'
      : null;

  const built = {
    query: geopasData.query,
    address: property.address,
    parcelId: property.parcelId,
    lv,
    ku: parcel?.cadastralTerritory
      ? `${parcel.cadastralTerritory}${parcel.landNumber ? ` · parcela ${parcel.landNumber}` : ''}`
      : '—',
    owner,
    owners,
    isTestOwner: isTestSample,
    ownerAccess: isTestSample ? 'test' : ownerAccess,
    ownerMessage,
    wsdpError: wsdpError || null,
    wsdpHint: wsdpHint || null,
    area: parcel?.area ?? (property.area ? `${property.area} m²` : '—'),
    areaSqm: property.areaSqm ?? property.area ?? null,
    cadastre: {
      landNumber: property.landNumber,
      cadastralArea: property.cadastralArea,
      parcelId: property.parcelId,
    },
    endpointStatus: geopasData.geopasMeta?.endpointStatus ?? [],
    safetyScore,
    valuation,
    risks: {
      flood: flood?.zone ?? 'nezjištěno',
      radon: radonRisk,
      mining: miningRisk,
      liens: effectiveLiens,
      hasExecution: effectiveHasExecution,
      hasMortgage: effectiveHasMortgage,
      summary: buildRiskSummary({
        flood,
        hasExecution: effectiveHasExecution,
        hasMortgage: effectiveHasMortgage,
        radonRisk,
        miningRisk,
      }),
    },
    zoning: {
      type: zoning?.landUse ?? 'nezjištěno',
      maxBuildup: zoning?.maxBuildupRate ?? '—',
      regulation: zoning?.heightRegulation ?? '—',
      raw: zoning,
    },
    amenities: amenities?.schools
      ? amenities
      : {
          schools: amenities?.filter?.((a) => a.type === 'school') ?? [],
          transit: amenities?.filter?.((a) => a.type === 'transit_stop') ?? [],
          health: amenities?.filter?.((a) => ['hospital', 'pharmacy'].includes(a.type)) ?? [],
        },
    noise: geopasData.noise?.length
      ? { summary: 'Údaje o hluku v lokalitě načteny z GeoPas', bands: geopasData.noise }
      : null,
    fetchedAt,
    dataSource: 'GeoPas API (ČÚZK, ČHMÚ, RÚIAN)',
    fromCache: false,
    municipality: geopasData.municipality || null,
    dataQuality: buildDataQuality({
      isTestSample,
      ownerAccess: isTestSample ? 'test' : ownerAccess,
      parcel,
      flood,
      zoning,
      geology,
      amenities: geopasData.amenities,
      safetyScore,
      endpointStatus: geopasData.geopasMeta?.endpointStatus,
      wsdpError,
      hasCrimeData: Boolean(geopasData.municipality?.crime?.totalPerThousand != null),
      hasSocioData: Boolean(
        geopasData.municipality?.foreclosures?.perHundred != null ||
          geopasData.municipality?.demographics?.unemploymentRate != null,
      ),
    }),
  };

  return sanitizeAnalysisWsdpTest(built);
}

function fieldStatus(status, label, detail = null) {
  return { status, label, detail };
}

function buildDataQuality({
  isTestSample,
  ownerAccess,
  parcel,
  flood,
  zoning,
  geology,
  amenities,
  safetyScore,
  endpointStatus,
  wsdpError,
  hasCrimeData = false,
  hasSocioData = false,
}) {
  const owners =
    isTestSample || ownerAccess === 'test'
      ? fieldStatus(
          'test_sample',
          'Vlastník / LV — testovací WSDP',
          'Ukázková data, ne skutečný vlastník. Vypněte GEOPAS_WSDP_TEST a použijte produkční WSDP.',
        )
      : ownerAccess === 'credentials' && parcel?.owner
        ? fieldStatus('live', 'Vlastník / LV — živá data')
        : ownerAccess === 'none'
          ? fieldStatus('unavailable', 'Vlastník / LV — vyžaduje WSDP', wsdpError || null)
          : fieldStatus('incomplete', 'Vlastník / LV — neúplné', wsdpError || null);

  const floodOk = flood && (flood.zone || flood.level);
  const zoningOk = zoning && (zoning.landUse || zoning.type);
  const geologyOk = geology && (geology.radon || geology.mining);
  const amenitiesOk = Array.isArray(amenities)
    ? amenities.length > 0
    : Boolean(amenities?.schools || amenities?.transit);

  const safetyPartial =
    safetyScore?.isPartial === true ||
    safetyScore?.mode === 'amenities_only' ||
    safetyScore?.mode === 'partial' ||
    (!hasCrimeData && safetyScore?.score != null);

  const safetyIncomplete = safetyScore?.score == null || safetyScore?.mode === 'incomplete';

  // „Live“ = celá analýza je úplná. Živý WSDP vlastník sám o sobě nestačí.
  let overall = 'partial';
  if (isTestSample) overall = 'partial';
  else if (owners.status === 'live' && !safetyPartial && !safetyIncomplete && hasCrimeData) {
    overall = 'live';
  }

  const safetyDetail = hasCrimeData
    ? 'Odvozeno z dostupných GeoPas vstupů — ne oficiální certifikát.'
    : safetyScore?.mode === 'amenities_only'
      ? 'Jen občanská vybavenost (POI). Chybí oficiální kriminalita i socioekonomika obce.'
      : 'Částečné skóre: chybí oficiální kriminalita/socioekonomika obce — váha jen na dostupných vstupech.';

  let summary;
  if (isTestSample) {
    summary = 'Část dat je živá (parcela/poloha), vlastník je v testovacím režimu WSDP.';
  } else if (safetyPartial || safetyIncomplete) {
    const ownerBit =
      owners.status === 'live' ? 'Vlastník načten živě. ' : '';
    summary = `${ownerBit}Safety Score je částečný (bez oficiální kriminality obce). Cenový odhad zůstává orientační heuristikou.`;
  } else if (owners.status === 'live') {
    summary = 'Katastrální vlastník načten živě. Cenový odhad zůstává orientační heuristikou.';
  } else {
    summary = 'Některá pole chybí nebo nejsou živá — zkontrolujte štítky níže.';
  }

  return {
    overall,
    summary,
    fields: {
      parcel: fieldStatus(
        parcel?.cadastralTerritory || parcel?.landNumber ? 'live' : 'incomplete',
        'Parcela / KÚ',
      ),
      owners,
      flood: fieldStatus(floodOk ? 'live' : 'incomplete', 'Záplavy'),
      zoning: fieldStatus(zoningOk ? 'live' : 'incomplete', 'Územní plán'),
      geology: fieldStatus(geologyOk ? 'live' : 'incomplete', 'Geologie / radon'),
      amenities: fieldStatus(amenitiesOk ? 'live' : 'incomplete', 'Vybavenost'),
      safetyScore: fieldStatus(
        safetyIncomplete ? 'incomplete' : hasCrimeData && !safetyPartial ? 'derived' : 'partial',
        'Safety Score',
        safetyDetail,
      ),
      valuation: fieldStatus(
        'heuristic',
        'Cenový odhad',
        'Heuristika regionu × m² × Safety Score — ne tržní data.',
      ),
    },
    endpoints: Array.isArray(endpointStatus) ? endpointStatus : [],
    meta: {
      hasCrimeData,
      hasSocioData,
      safetyMode: safetyScore?.mode || null,
    },
  };
}

function estimateBasePrice(property, safetyScore) {
  const basePerSqm =
    property.region === 'Praha' ? 120000 : property.region === 'Brno' ? 75000 : 45000;
  const area = property.area ?? 60;
  // Null score → neutrální 50 (heuristika), ne fiktivní „průměrná lokalita“ v UI
  const scoreNum =
    safetyScore != null && Number.isFinite(Number(safetyScore)) ? Number(safetyScore) : 50;
  const safetyMultiplier = 0.8 + (scoreNum / 100) * 0.4;
  return basePerSqm * area * safetyMultiplier;
}

function formatPrice(price) {
  return new Intl.NumberFormat('cs-CZ', {
    style: 'currency',
    currency: 'CZK',
    maximumFractionDigits: 0,
  }).format(Math.round(price / 100000) * 100000);
}

function buildRiskSummary({ flood, hasExecution, hasMortgage, radonRisk, miningRisk }) {
  const risks = [];
  if (flood?.zone === 'Q100' || flood?.zone === 'Q20' || flood?.level === 'elevated') {
    risks.push('⚠️ Záplavové území');
  }
  if (hasExecution) risks.push('🔴 Exekuce na LV');
  if (hasMortgage) risks.push('🟡 Zástavní právo');
  if (radonRisk === 'high') risks.push('☢️ Zvýšené radonové riziko');
  if (miningRisk) risks.push('⛏️ Poddolované území');
  return risks.length ? risks : ['✅ Bez zjištěných rizik v dostupných registrech'];
}
