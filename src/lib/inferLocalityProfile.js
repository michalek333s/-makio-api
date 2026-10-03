/**
 * Heuristika soft profilu lokality z GeoPas analýzy (když chybí seed/DB).
 */

export function inferLocalityProfileFromAnalysis(analysis) {
  if (!analysis || analysis.notFound) return null;

  const schools = analysis.amenities?.schools?.length ?? 0;
  const transit = analysis.amenities?.transit?.length ?? 0;
  const health = analysis.amenities?.health?.length ?? 0;
  const poi = schools + transit + health;
  const hasNoiseBands = Boolean(analysis.noise?.bands?.length);
  const ku = String(analysis.ku || analysis.cadastre?.cadastralArea || '');
  const address = String(analysis.address || '');
  const muni = String(analysis.municipality?.name || ku.split('·')[0] || '').trim();

  const looksVillage =
    /\bu\b/i.test(ku) ||
    /vesnic|osada|lhota|lhotka|lískovec|paskov|baška|říčky/i.test(`${ku} ${address} ${muni}`) ||
    (poi <= 6 && !hasNoiseBands && !/praha|brno|ostrava|plzeň/i.test(address));

  const looksEstate = poi >= 20 || /sídlišt|panel/i.test(`${ku} ${address}`);
  const looksCenter = /centrum|náměstí|masaryk/i.test(address) || (transit >= 8 && schools >= 5);

  let vibe = 'smisene';
  let noiseFeel = hasNoiseBands ? 'hlucne' : 'neznamo';
  let confidence = 'low';
  let notes = '';

  if (looksVillage && !looksCenter) {
    vibe = 'klidna_vesnice';
    noiseFeel = hasNoiseBands ? 'prumer' : 'tiche';
    confidence = hasNoiseBands ? 'low' : 'medium';
    notes =
      'Odhad z GeoPas: nižší hustota služeb / mimo hlukovou aglomeraci — typicky klidnější obec. Ověřte na místě.';
  } else if (looksCenter) {
    vibe = 'centrum';
    noiseFeel = 'hlucne';
    confidence = 'low';
    notes = 'Odhad z GeoPas: husté POI — spíš městský ruch.';
  } else if (looksEstate) {
    vibe = 'sidliste';
    noiseFeel = 'prumer';
    confidence = 'low';
    notes = 'Odhad z GeoPas: hustá vybavenost — spíš sídlištní charakter.';
  } else if (poi <= 4 && !hasNoiseBands) {
    vibe = 'primesti';
    noiseFeel = 'tiche';
    confidence = 'low';
    notes = 'Odhad z GeoPas: řídké POI, bez hlukových pásem.';
  } else {
    return null;
  }

  return {
    vibe,
    noiseFeel,
    notes,
    source: 'ai',
    confidence,
    tags: ['inferred', 'geopas'],
    municipalityName: muni || null,
  };
}
