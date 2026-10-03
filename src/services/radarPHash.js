/**
 * Perceptual hash compare — Hamming na 64bit hashi.
 * Stahování fotek je volitelné (stub); engine pracuje se stored hashi.
 *
 * Formáty: hex 16 znaků, `0x…`, BigInt, decimal string, 64-bit binary string.
 */

export const PHASH_HAMMING_THRESHOLD = 8;

function toBigInt64(hash) {
  if (hash == null || hash === '') return null;
  if (typeof hash === 'bigint') {
    return hash & 0xffff_ffff_ffff_ffffn;
  }
  if (typeof hash === 'number' && Number.isFinite(hash)) {
    return BigInt(Math.trunc(hash)) & 0xffff_ffff_ffff_ffffn;
  }
  const s = String(hash).trim().toLowerCase();
  if (!s) return null;

  if (/^[01]{64}$/.test(s)) {
    return BigInt(`0b${s}`);
  }
  if (/^0x[0-9a-f]{1,16}$/.test(s)) {
    return BigInt(s) & 0xffff_ffff_ffff_ffffn;
  }
  if (/^[0-9a-f]{16}$/.test(s)) {
    return BigInt(`0x${s}`);
  }
  if (/^[0-9a-f]{1,15}$/.test(s)) {
    return BigInt(`0x${s.padStart(16, '0')}`);
  }
  if (/^\d+$/.test(s)) {
    try {
      return BigInt(s) & 0xffff_ffff_ffff_ffffn;
    } catch {
      return null;
    }
  }
  return null;
}

/** Počet nastavených bitů v 64bit hodnotě. */
export function popcount64(n) {
  let x = typeof n === 'bigint' ? n : BigInt(n);
  x &= 0xffff_ffff_ffff_ffffn;
  let c = 0;
  while (x > 0n) {
    x &= x - 1n;
    c += 1;
  }
  return c;
}

/**
 * Hammingova vzdálenost dvou 64bit pHashů.
 * @returns {number} 0–64, nebo Infinity pokud hash nejde parsovat
 */
export function hammingDistance(hashA, hashB) {
  const a = toBigInt64(hashA);
  const b = toBigInt64(hashB);
  if (a == null || b == null) return Infinity;
  return popcount64(a ^ b);
}

export function isPHashDuplicate(hashA, hashB, threshold = PHASH_HAMMING_THRESHOLD) {
  const d = hammingDistance(hashA, hashB);
  return Number.isFinite(d) && d <= threshold;
}

export function hashesOf(listing) {
  const out = [];
  const push = (h) => {
    if (h == null || h === '') return;
    if (Array.isArray(h)) {
      h.forEach(push);
      return;
    }
    out.push(h);
  };
  push(listing?.photoPHash || listing?.pHash || listing?.imageHash || listing?.photo_phash);
  push(listing?.imageHashes || listing?.image_hashes);
  return out;
}

/**
 * Najde nejbližší pHash v referenčních inzerátech (jedno pole hashů vs. pole hashů).
 */
export function findPHashMatch(hashOrListing, references = [], threshold = PHASH_HAMMING_THRESHOLD) {
  const hashes =
    hashOrListing && typeof hashOrListing === 'object' && !Array.isArray(hashOrListing)
      ? hashesOf(hashOrListing)
      : hashesOf({ photoPHash: hashOrListing });
  if (!hashes.length) return null;
  let best = null;
  for (const ref of references) {
    const refHashes = hashesOf(ref);
    for (const a of hashes) {
      for (const b of refHashes) {
        const dist = hammingDistance(a, b);
        if (!Number.isFinite(dist) || dist > threshold) continue;
        if (!best || dist < best.distance) {
          best = {
            distance: dist,
            listingId: ref.listingId || ref.id || null,
            url: ref.url || ref.sourceUrl || ref.source_url || null,
            agencyName: ref.agencyName || ref.agency_name || null,
            ref,
          };
        }
      }
    }
  }
  return best;
}

const GRAY_W = 9;
const GRAY_H = 8;

/** dHash z pole 9×8 jasů (0–255) → 16 hex znaků. */
export function dHashFromGrayPixels(pixels, width = GRAY_W, height = GRAY_H) {
  if (!pixels || pixels.length < width * height) return null;
  let bits = 0n;
  let i = 0n;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = pixels[y * width + x];
      const right = pixels[y * width + x + 1];
      if (left > right) bits |= 1n << i;
      i += 1n;
    }
  }
  return bits.toString(16).padStart(16, '0');
}

async function downloadImageBuffer(imageUrl, timeoutMs = 8000) {
  const url = String(imageUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'image/*', 'User-Agent': 'NemioRadar/2.0' },
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 32 || buf.length > 8_000_000) return null;
  return buf;
}

/**
 * Stáhne fotku a spočítá 64-bit dHash (hex).
 * Vyžaduje `sharp` (volitelná závislost). Bez ní vrací null — engine dál pracuje se stored hashi.
 */
export async function calculatePhash(imageUrl) {
  const buf = await downloadImageBuffer(imageUrl);
  if (!buf) return null;
  try {
    const sharpMod = await import('sharp');
    const sharp = sharpMod.default || sharpMod;
    const { data } = await sharp(buf)
      .grayscale()
      .resize(GRAY_W, GRAY_H, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return dHashFromGrayPixels(data, GRAY_W, GRAY_H);
  } catch {
    return null;
  }
}

export async function calculatePhashes(imageUrls = [], { max = 3 } = {}) {
  const urls = (Array.isArray(imageUrls) ? imageUrls : []).filter(Boolean).slice(0, max);
  const hashes = [];
  for (const u of urls) {
    const h = await calculatePhash(u);
    if (h) hashes.push(h);
  }
  return hashes;
}
