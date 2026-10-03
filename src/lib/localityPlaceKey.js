/**
 * Normalizace a lookup klíčů lokalit (obec / k.ú.).
 */

export function foldPlace(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function placeKeyFromParts({ municipality, cadastralArea, city } = {}) {
  const muni = foldPlace(municipality || '');
  const ku = foldPlace(cadastralArea || '');
  const c = foldPlace(city || '');

  // „Lískovec u Frýdku-Místku“ → liskovec
  const muniShort = muni
    .replace(/\bu\b.+$/, '')
    .replace(/\b(obec|mestys|mesto)\b/g, '')
    .trim();

  if (muniShort && c && !c.includes(muniShort) && !muniShort.includes(c)) {
    return `${muniShort}|${c}`.replace(/\s+/g, '-');
  }
  if (muniShort) return muniShort.replace(/\s+/g, '-');
  if (ku) {
    return ku
      .replace(/\bu\b.+$/, '')
      .trim()
      .replace(/\s+/g, '-');
  }
  return '';
}

export function placeKeysFromAnalysis(analysis) {
  const ku = analysis?.ku || analysis?.cadastre?.cadastralArea || '';
  const muni =
    analysis?.municipality?.name ||
    analysis?.municipalityName ||
    (ku.includes('·') ? ku.split('·')[0].trim() : ku.replace(/·.*/, '').trim()) ||
    '';
  const address = analysis?.address || '';
  const cityMatch = address.match(/,\s*([^,]+)$/);
  const city = cityMatch?.[1]?.replace(/\d{3}\s*\d{2}/, '').trim() || '';

  const keys = new Set();
  const primary = placeKeyFromParts({ municipality: muni, cadastralArea: ku, city });
  if (primary) keys.add(primary);

  const short = foldPlace(muni)
    .replace(/\bu\b.+$/, '')
    .trim()
    .replace(/\s+/g, '-');
  if (short) keys.add(short);

  // Z adresy „Lískovec 310, Frýdek-Místek“
  const addrPlace = foldPlace(address).match(
    /^([a-z][a-z0-9\- ]+?)\s+\d/,
  );
  if (addrPlace?.[1]) {
    keys.add(addrPlace[1].trim().replace(/\s+/g, '-'));
  }

  return [...keys].filter(Boolean);
}

export const VIBE_LABELS = {
  klidna_vesnice: 'Klidná vesnice',
  primesti: 'Příměstí / satelit',
  sidliste: 'Sídliště',
  centrum: 'Centrum města',
  prumysl: 'Průmyslové okolí',
  rekreace: 'Rekreační lokalita',
  smisene: 'Smíšená zástavba',
  neznamo: 'Neznámý charakter',
};

export const NOISE_LABELS = {
  tiche: 'Spíš tiché',
  prumer: 'Průměrný ruch',
  hlucne: 'Spíš hlučné',
  neznamo: 'Hluk neznámý',
};

export function formatLocalityProfileLine(profile) {
  if (!profile) return '';
  const vibe = VIBE_LABELS[profile.vibe] || profile.vibe || '';
  const noise = NOISE_LABELS[profile.noise_feel] || NOISE_LABELS[profile.noiseFeel] || '';
  const parts = [vibe, noise].filter(Boolean);
  const notes = profile.notes ? String(profile.notes).trim() : '';
  if (!parts.length && !notes) return '';
  const head = parts.length ? `**Profil lokality:** ${parts.join(' · ')}` : '**Profil lokality**';
  const src =
    profile.source === 'system'
      ? 'systém'
      : profile.source === 'broker'
        ? 'makléř'
        : profile.source || 'Makio';
  return `${head}${notes ? ` — ${notes}` : ''} _(zdroj: ${src})_`;
}
