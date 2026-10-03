/**
 * Makio Safety Scoring Engine
 *
 * Váhy (když jsou všechny vstupy):
 *   40 % Kriminalita
 *   35 % Socioekonomika (exekuce + nezaměstnanost)
 *   25 % Občanská vybavenost
 *
 * Chybějící pilíře se do průměru NEZAČÍTÁVAJÍ jako fiktivní 50 —
 * váhy se přepočítají jen přes dostupné vstupy (isPartial).
 */

const BENCHMARKS = {
  crime: {
    low: 10,
    average: 25,
    high: 60,
    max: 120,
  },
  foreclosures: {
    low: 2,
    average: 6,
    high: 15,
    max: 30,
  },
  unemployment: {
    low: 1.5,
    average: 3.5,
    high: 8,
    max: 20,
  },
  amenities: {
    schools: { good: 3, ok: 1 },
    transit: { good: 5, ok: 2 },
    health: { good: 2, ok: 1 },
  },
};

function normalizeInverse(value, low, average, high, max) {
  if (value <= low) return 100;
  if (value <= average) return 100 - ((value - low) / (average - low)) * 30;
  if (value <= high) return 70 - ((value - average) / (high - average)) * 40;
  if (value <= max) return 30 - ((value - high) / (max - high)) * 30;
  return 0;
}

function normalizeAmenities(count, good, ok) {
  if (count >= good) return 100;
  if (count >= ok) return 60 + ((count - ok) / (good - ok)) * 40;
  if (count > 0) return 30 + (count / ok) * 30;
  return 0;
}

function unavailable(weight) {
  return {
    score: null,
    weight,
    available: false,
    source: 'unavailable',
    label: 'Nedostupné',
  };
}

/**
 * @param {object} geopasData
 * @returns {object} safetyScore payload for API/UI
 */
export function calculateSafetyScore(geopasData) {
  const { municipality, amenities } = geopasData || {};
  const details = {};
  const present = {
    crime: false,
    foreclosures: false,
    unemployment: false,
    amenities: false,
  };

  let crimeScore = null;
  let foreclosureScore = null;
  let unemploymentScore = null;
  let amenitiesScore = null;

  if (municipality?.crime && municipality.crime.totalPerThousand != null) {
    const crimeRate = Number(municipality.crime.totalPerThousand);
    if (Number.isFinite(crimeRate)) {
      present.crime = true;
      crimeScore = normalizeInverse(
        crimeRate,
        BENCHMARKS.crime.low,
        BENCHMARKS.crime.average,
        BENCHMARKS.crime.high,
        BENCHMARKS.crime.max,
      );
      details.crime = {
        value: crimeRate,
        label: `${crimeRate.toFixed(1)} trestných činů / 1000 ob.`,
        source: 'Policie ČR',
      };
    }
  }

  if (municipality?.foreclosures && municipality.foreclosures.perHundred != null) {
    const foreclosureRate = Number(municipality.foreclosures.perHundred);
    if (Number.isFinite(foreclosureRate)) {
      present.foreclosures = true;
      foreclosureScore = normalizeInverse(
        foreclosureRate,
        BENCHMARKS.foreclosures.low,
        BENCHMARKS.foreclosures.average,
        BENCHMARKS.foreclosures.high,
        BENCHMARKS.foreclosures.max,
      );
      details.foreclosures = {
        value: foreclosureRate,
        label: `${foreclosureRate.toFixed(1)} exekucí / 100 obyvatel`,
        source: 'GeoPas / evidence exekucí',
      };
    }
  }

  if (municipality?.demographics?.unemploymentRate != null) {
    const unemployRate = Number(municipality.demographics.unemploymentRate);
    if (Number.isFinite(unemployRate)) {
      present.unemployment = true;
      unemploymentScore = normalizeInverse(
        unemployRate,
        BENCHMARKS.unemployment.low,
        BENCHMARKS.unemployment.average,
        BENCHMARKS.unemployment.high,
        BENCHMARKS.unemployment.max,
      );
      details.unemployment = {
        value: unemployRate,
        label: `${unemployRate.toFixed(1)} % nezaměstnanost`,
        source: 'GeoPas / MPSV',
      };
    }
  }

  const amenityList = Array.isArray(amenities)
    ? amenities
    : amenities?.schools
      ? [
          ...(amenities.schools || []).map((a) => ({ ...a, type: 'school' })),
          ...(amenities.transit || []).map((a) => ({ ...a, type: 'transit_stop' })),
          ...(amenities.health || []).map((a) => ({ ...a, type: a.type || 'hospital' })),
        ]
      : [];

  if (amenityList.length > 0) {
    present.amenities = true;
    const schoolCount = amenityList.filter((a) => a.type === 'school').length;
    const transitCount = amenityList.filter((a) => a.type === 'transit_stop').length;
    const healthCount = amenityList.filter((a) =>
      ['hospital', 'pharmacy'].includes(a.type),
    ).length;

    const schoolScore = normalizeAmenities(
      schoolCount,
      BENCHMARKS.amenities.schools.good,
      BENCHMARKS.amenities.schools.ok,
    );
    const transitScore = normalizeAmenities(
      transitCount,
      BENCHMARKS.amenities.transit.good,
      BENCHMARKS.amenities.transit.ok,
    );
    const healthScore = normalizeAmenities(
      healthCount,
      BENCHMARKS.amenities.health.good,
      BENCHMARKS.amenities.health.ok,
    );

    amenitiesScore = schoolScore * 0.4 + transitScore * 0.4 + healthScore * 0.2;
    details.amenities = {
      schools: schoolCount,
      transit: transitCount,
      health: healthCount,
      label: `${schoolCount} škol, ${transitCount} zastávek, ${healthCount} zdravotnických zař.`,
      source: 'GeoPas POI',
    };
  }

  let socioScore = null;
  const socioParts = [];
  if (present.foreclosures) socioParts.push({ score: foreclosureScore, w: 0.571 });
  if (present.unemployment) socioParts.push({ score: unemploymentScore, w: 0.429 });
  if (socioParts.length === 1) {
    socioScore = socioParts[0].score;
  } else if (socioParts.length === 2) {
    const tw = socioParts[0].w + socioParts[1].w;
    socioScore =
      (socioParts[0].score * socioParts[0].w + socioParts[1].score * socioParts[1].w) / tw;
  }

  const pillars = [];
  if (present.crime) pillars.push({ key: 'crime', score: crimeScore, weight: 0.4 });
  if (socioScore != null) pillars.push({ key: 'socio', score: socioScore, weight: 0.35 });
  if (present.amenities) pillars.push({ key: 'amenities', score: amenitiesScore, weight: 0.25 });

  const missingInputs = [];
  if (!present.crime) missingInputs.push('crime');
  if (!present.foreclosures) missingInputs.push('foreclosures');
  if (!present.unemployment) missingInputs.push('unemployment');
  if (!present.amenities) missingInputs.push('amenities');

  const inputsUsed = pillars.map((p) => p.key);
  // Kriminalita z GeoPas zatím není — partial i když máme socio + POI.
  const isPartial =
    missingInputs.includes('crime') ||
    missingInputs.includes('foreclosures') ||
    missingInputs.includes('unemployment');
  const coveragePct = Math.round((pillars.length / 3) * 100);

  let finalScore = null;
  let mode = 'incomplete';
  if (pillars.length === 0) {
    mode = 'incomplete';
  } else if (pillars.length === 1 && pillars[0].key === 'amenities') {
    mode = 'amenities_only';
    finalScore = Math.round(pillars[0].score);
  } else {
    const totalW = pillars.reduce((s, p) => s + p.weight, 0);
    finalScore = Math.round(pillars.reduce((s, p) => s + (p.score * p.weight) / totalW, 0));
    mode = isPartial ? 'partial' : 'full';
  }

  const confidence =
    mode === 'full' ? 'high' : mode === 'partial' ? 'medium' : mode === 'amenities_only' ? 'low' : 'none';

  const interpretation = getInterpretation(finalScore, { isPartial: mode !== 'full', mode });

  return {
    score: finalScore,
    ...interpretation,
    isPartial: mode !== 'full',
    mode,
    confidence,
    coveragePct,
    inputsUsed,
    missingInputs,
    breakdown: {
      crime: present.crime
        ? { score: Math.round(crimeScore), weight: '40 %', available: true, ...details.crime }
        : unavailable('40 %'),
      socioeconomic:
        socioScore != null
          ? { score: Math.round(socioScore), weight: '35 %', available: true }
          : unavailable('35 %'),
      foreclosures: present.foreclosures
        ? {
            score: Math.round(foreclosureScore),
            weight: '20 %',
            available: true,
            ...details.foreclosures,
          }
        : unavailable('20 %'),
      unemployment: present.unemployment
        ? {
            score: Math.round(unemploymentScore),
            weight: '15 %',
            available: true,
            ...details.unemployment,
          }
        : unavailable('15 %'),
      amenities: present.amenities
        ? {
            score: Math.round(amenitiesScore),
            weight: '25 %',
            available: true,
            ...details.amenities,
          }
        : unavailable('25 %'),
    },
  };
}

function getInterpretation(score, { isPartial, mode } = {}) {
  if (score == null || mode === 'incomplete') {
    return {
      label: 'Safety Score nedostupný',
      color: 'zinc',
      emoji: '⚪',
      targetBuyer: '—',
      marketingTip:
        'Chybí vstupy pro skóre (kriminalita, socio, vybavenost). Počkejte na kompletnější GeoPas data nebo ověřte lokalitu ručně.',
      strategy:
        'Nespoléhejte na Safety Score — použijte katastr, záplavy a lokální znalost.',
    };
  }

  let base;
  if (score >= 80) {
    base = {
      label: 'Velmi bezpečná lokalita',
      color: 'green',
      emoji: '🟢',
      targetBuyer: 'Rodiny s dětmi, senioři',
      marketingTip:
        'Zdůrazněte klid, bezpečí a komunitu. Použijte slova jako „klidná ulice“, „sousedská komunita“, „ideální pro rodinu“.',
      strategy: 'Optimistická cena je reálná. Zájem o tyto lokality roste.',
    };
  } else if (score >= 65) {
    base = {
      label: 'Nadprůměrná lokalita',
      color: 'teal',
      emoji: '🔵',
      targetBuyer: 'Mladé rodiny, páry',
      marketingTip: 'Komunikujte dostupnost, dobré spojení a rozvíjející se čtvrť.',
      strategy: 'Reálná cena je dosažitelná. Marketing na young professionals.',
    };
  } else if (score >= 50) {
    base = {
      label: 'Průměrná lokalita',
      color: 'amber',
      emoji: '🟡',
      targetBuyer: 'Investoři, mladí single',
      marketingTip: 'Zaměřte se na výnosový potenciál a dostupnost ceny.',
      strategy: 'Reálná nebo pesimistická cena. Zdůrazněte investiční potenciál.',
    };
  } else if (score >= 35) {
    base = {
      label: 'Podprůměrná lokalita',
      color: 'orange',
      emoji: '🟠',
      targetBuyer: 'Investoři (hotovostní kupci)',
      marketingTip: 'Buďte upřímní o lokalitě, zdůrazněte hodnotu nemovitosti samotné.',
      strategy: 'Pesimistická cena. Doporučujeme advokátní úschovu a hotovostního kupce.',
    };
  } else {
    base = {
      label: 'Riziková lokalita',
      color: 'red',
      emoji: '🔴',
      targetBuyer: 'Zkušení investoři',
      marketingTip: 'Transparentní komunikace. Nízká cena je hlavní argument.',
      strategy:
        'UPOZORNĚNÍ: Doporučujeme zvýšenou due diligence. Cílte výhradně na hotovostní investory.',
    };
  }

  if (!isPartial) return base;

  if (mode === 'amenities_only') {
    return {
      ...base,
      label: `Orientační skóre vybavenosti (${base.label.toLowerCase()})`,
      color: 'amber',
      emoji: '🟡',
      marketingTip: `ČÁSTEČNÉ — jen občanská vybavenost, bez kriminality obce. ${base.marketingTip}`,
      strategy: `ČÁSTEČNÉ skóre (jen POI). ${base.strategy} Oficiální kriminalitu ověřte samostatně.`,
    };
  }

  return {
    ...base,
    label: `Orientační skóre — ${base.label.toLowerCase()}`,
    marketingTip: `ČÁSTEČNÉ — chybí oficiální kriminalita/socio obce. ${base.marketingTip}`,
    strategy: `ČÁSTEČNÉ skóre. ${base.strategy}`,
  };
}
