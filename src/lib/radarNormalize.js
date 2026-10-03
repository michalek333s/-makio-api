/**
 * Normalizace Radar inzerátů — cena, m², dispozice, telefony E.164 CZ, unique URL.
 */

export const PRIVATE_RADAR_SOURCES = new Set([
  'bazos',
  'bezrealitky',
  'facebook',
  'facebook_marketplace',
  'sbazar',
]);

export const REFERENCE_RADAR_SOURCES = new Set(['sreality', 'idnes', 'idnes_reality']);

const LAYOUT_RE = /(\d)\s*\+\s*(kk|\d)/i;
const AREA_RE = /(\d{1,4}(?:[.,]\d{1,2})?)\s*m(?:\u00b2|2|\s*2)(?!\w)/i;

/**
 * CZ mobil/pevná linka → E.164 `+420XXXXXXXXX`, jinak null.
 * Přijímá 777 123 456, 00420…, +420…, 420…
 */
export function normalizeCzPhone(raw) {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('420') && digits.length === 12) {
    digits = digits.slice(3);
  } else if (digits.startsWith('00420') && digits.length === 14) {
    digits = digits.slice(5);
  }

  if (digits.length === 9 && /^[1-9]/.test(digits)) {
    return `+420${digits}`;
  }
  return null;
}

/** Všechny CZ telefony z textu / pole. */
export function extractCzPhones(...blobs) {
  const text = blobs
    .flat()
    .filter((v) => v != null)
    .map((v) => (typeof v === 'string' ? v : String(v)))
    .join(' ');
  if (!text) return [];

  const found = new Set();
  const candidates = [
    /\+420[\s./-]*(\d[\s./-]*){9}/g,
    /\b00420[\s./-]*(\d[\s./-]*){9}/g,
    /\b420[\s./-]*([1-9](?:[\s./-]*\d){8})\b/g,
    /\b([1-9]\d{2}[\s./-]*\d{3}[\s./-]*\d{3})\b/g,
  ];

  for (const re of candidates) {
    const copy = new RegExp(re.source, re.flags);
    let m;
    while ((m = copy.exec(text))) {
      const n = normalizeCzPhone(m[0]);
      if (n) found.add(n);
    }
  }
  return [...found];
}

export function parsePriceCzk(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.round(raw);
    return n > 0 ? n : null;
  }
  if (typeof raw === 'object') {
    const formatted =
      raw.formatted_amount ||
      raw.formatted_amount_zeros_stripped ||
      raw.formattedAmount ||
      raw.text;
    const fromFormatted = parsePriceCzk(formatted);
    if (fromFormatted) return fromFormatted;
    const amount = parsePriceCzk(raw.amount ?? raw.value ?? raw.price);
    if (amount) return amount;
    const offset = Number(raw.amount_with_offset_in_currency);
    if (Number.isFinite(offset) && offset >= 500_000) return Math.round(offset / 100);
    return null;
  }
  const s = String(raw).replace(/\s/g, '').replace(/Kč|CZK|,-/gi, '');
  if (/^\d+[.,]\d{1,2}$/.test(s)) {
    const n = Math.round(parseFloat(s.replace(',', '.')));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseFloorArea(raw, blob = '') {
  if (raw != null && raw !== '') {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(',', '.').replace(/[^\d.]/g, ''));
    if (Number.isFinite(n) && n >= 5 && n <= 5000) return Math.round(n);
  }
  const m = String(blob || '').match(AREA_RE);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(n) && n >= 5 && n <= 5000 ? Math.round(n) : null;
}

/** `2+kk`, `3+1` — exact disposition token. */
export function parseLayout(raw, blob = '') {
  const tryMatch = (s) => {
    const m = String(s || '').match(LAYOUT_RE);
    if (!m) return null;
    return `${m[1]}+${m[2].toLowerCase()}`;
  };
  return tryMatch(raw) || tryMatch(blob);
}

export function canonicalizeSourceUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'].forEach((k) =>
      u.searchParams.delete(k),
    );
    let href = u.toString();
    if (href.endsWith('/') && u.pathname !== '/') href = href.slice(0, -1);
    return href;
  } catch {
    const s = String(url).trim().split('#')[0];
    return s || null;
  }
}

/** První město z locality (`Ostrava, Poruba` → `Ostrava`). */
export function localityToString(locality) {
  if (locality == null || locality === '') return '';
  if (typeof locality === 'string') return locality.trim();
  if (typeof locality === 'number') return String(locality);
  if (Array.isArray(locality)) {
    return locality.map(localityToString).filter(Boolean).join(', ');
  }
  if (typeof locality === 'object') {
    const parts = [
      locality.value,
      locality.name,
      locality.label,
      locality.text,
      locality.city,
      locality.obec,
      locality.district,
      locality.citypart,
      locality.city_part,
      locality.display_name,
      locality.reverse_geocode,
      locality.city_page,
    ]
      .map(localityToString)
      .filter(Boolean);
    return [...new Set(parts)].join(', ');
  }
  return String(locality);
}

export function extractCity(locality) {
  const text = localityToString(locality);
  if (!text) return null;
  const first = text
    .split(/[,–—-]/)[0]
    .replace(/\d+/g, '')
    .replace(/\b(okres|kraj|město)\b/gi, '')
    .trim();
  const city = first.replace(/\s+/g, ' ').trim();
  return city.length >= 2 ? city : null;
}

export function radarStreamForSource(source) {
  const s = String(source || '').toLowerCase();
  if (PRIVATE_RADAR_SOURCES.has(s)) return 'private';
  if (REFERENCE_RADAR_SOURCES.has(s)) return 'reference';
  return 'unknown';
}

const GENERIC_TITLE_RE =
  /^(facebook(\s+marketplace)?|marketplace|inzer[aá]t|nab[ií]dka|nezn[aá]m[aá]\s+lokalita)$/i;

export function isGenericListingTitle(title) {
  const t = String(title || '').trim();
  return !t || GENERIC_TITLE_RE.test(t);
}

/** Titulek, který makléř může číst — ne placeholder z portálu. */
export function composeListingTitle(listing = {}) {
  const existing = String(listing.title || '').trim();
  if (existing && !isGenericListingTitle(existing)) return existing.slice(0, 160);
  const loc = localityToString(listing.locality);
  const layout = listing.layout || parseLayout(null, listing.description || '');
  const area = listing.floorArea ? `${listing.floorArea} m²` : '';
  const bits = [layout, area, loc].filter(Boolean);
  if (bits.length >= 2) return bits.join(' · ');
  const desc = String(listing.description || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (desc.length >= 18) {
    const cut = desc.slice(0, 110).trim();
    return cut.length < desc.length ? `${cut}…` : cut;
  }
  if (listing.price) {
    const p = Number(listing.price).toLocaleString('cs-CZ');
    return loc ? `Nabídka ${p} Kč · ${loc}` : `Nabídka ${p} Kč`;
  }
  if (loc) return loc;
  return listing.source === 'facebook' || listing.source === 'facebook_marketplace'
    ? 'Soukromá nabídka (Facebook)'
    : existing || 'Inzerát';
}

/**
 * Doplní chybějící normalizovaná pole. Nemění agency signály.
 */
export function finishNormalizedListing(listing = {}) {
  const blob = `${listing.title || ''} ${listing.description || ''}`;
  const price = listing.price != null ? parsePriceCzk(listing.price) : parsePriceCzk(listing.priceText) || null;
  const floorArea = listing.floorArea ?? parseFloorArea(listing.usableArea, blob);
  const layout = parseLayout(listing.layout, blob) || listing.layout || null;
  const url = canonicalizeSourceUrl(listing.url || listing.sourceUrl || listing.detailUrl);
  const phones = listing.phoneE164
    ? [listing.phoneE164]
    : extractCzPhones(listing.phone, listing.phones, listing.contactPhone, blob);
  const phoneE164 = phones[0] || listing.phoneE164 || null;
  const localityText = localityToString(listing.locality) || localityToString(listing.city);
  const city = localityToString(listing.city) || extractCity(localityText);
  let title = typeof listing.title === 'string' ? listing.title.trim() : localityToString(listing.title);
  if (isGenericListingTitle(title)) {
    title = composeListingTitle({
      ...listing,
      locality: localityText,
      layout,
      floorArea: floorArea ?? listing.floorArea,
      price: price ?? listing.price,
      description: listing.description,
    });
  }
  const lat = listing.lat ?? listing.latitude ?? null;
  const lng = listing.lng ?? listing.lon ?? listing.longitude ?? null;
  const photoPHash = listing.photoPHash || listing.pHash || listing.imageHash || null;
  const imageUrls = Array.isArray(listing.imageUrls)
    ? listing.imageUrls.filter(Boolean)
    : Array.isArray(listing.image_urls)
      ? listing.image_urls.filter(Boolean)
      : listing.imageUrl
        ? [listing.imageUrl]
        : [];
  const imageHashes = Array.isArray(listing.imageHashes)
    ? listing.imageHashes.filter(Boolean)
    : Array.isArray(listing.image_hashes)
      ? listing.image_hashes.filter(Boolean)
      : [];
  const pricePerSqm =
    listing.pricePerSqm ??
    (price && floorArea ? Math.round(price / floorArea) : null);

  return {
    ...listing,
    title: title || listing.title || null,
    price: price ?? listing.price ?? null,
    floorArea: floorArea ?? listing.floorArea ?? null,
    layout,
    url: url || listing.url || null,
    sourceUrl: url || listing.sourceUrl || listing.url || null,
    phoneE164,
    phones,
    city: city || null,
    locality: localityText || null,
    lat: lat != null && Number.isFinite(Number(lat)) ? Number(lat) : listing.lat ?? null,
    lon: lng != null && Number.isFinite(Number(lng)) ? Number(lng) : listing.lon ?? null,
    lng: lng != null && Number.isFinite(Number(lng)) ? Number(lng) : listing.lng ?? listing.lon ?? null,
    photoPHash,
    imageUrls,
    imageHashes,
    pricePerSqm,
    radarStream: listing.radarStream || radarStreamForSource(listing.source),
  };
}
