/**
 * Matching engine — aktivní radar_alerts × nový / zlevněný listing.
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function overlapsText(hay, needles) {
  if (!Array.isArray(needles) || needles.length === 0) return true;
  const h = String(hay || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (!h) return false;
  return needles.some((n) => {
    const needle = String(n || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
    return needle && h.includes(needle);
  });
}

/**
 * @param {object} listing — DB / normalized shape
 * @param {object} alert
 * @returns {{ ok: boolean, reason?: string, priority?: boolean }}
 */
export function listingMatchesAlert(listing, alert) {
  if (!listing || !alert?.is_active) return { ok: false };

  const deal = listing.deal_type || listing.dealType || 'sale';
  if (Array.isArray(alert.deal_types) && alert.deal_types.length) {
    if (!alert.deal_types.includes(deal)) return { ok: false };
  }

  const pType = listing.property_type || listing.propertyType || 'flat';
  if (Array.isArray(alert.property_types) && alert.property_types.length) {
    if (!alert.property_types.includes(pType)) return { ok: false };
  }

  const price = num(listing.price);
  const minP = num(alert.min_price);
  const maxP = num(alert.max_price);
  if (minP != null && price != null && price < minP) return { ok: false };
  if (maxP != null && price != null && price > maxP) return { ok: false };

  const area = num(listing.floor_area ?? listing.floorArea ?? listing.surface_area);
  const minA = num(alert.min_surface);
  const maxA = num(alert.max_surface);
  if (minA != null && area != null && area < minA) return { ok: false };
  if (maxA != null && area != null && area > maxA) return { ok: false };

  if (alert.private_seller_only) {
    const priv =
      listing.is_private_seller === true ||
      listing.isPrivateSeller === true ||
      listing.radarStatus === 'NEW_PRIVATE' ||
      (!listing.isAgencyListing && listing.fsboSignal);
    if (!priv) return { ok: false };
  }

  if (Array.isArray(alert.layouts) && alert.layouts.length) {
    const layout = String(listing.layout || '').toLowerCase();
    if (!alert.layouts.some((l) => layout.includes(String(l).toLowerCase()))) {
      return { ok: false };
    }
  }

  if (Array.isArray(alert.regions) && alert.regions.length) {
    if (!overlapsText(listing.region, alert.regions)) return { ok: false };
  }

  if (Array.isArray(alert.districts) && alert.districts.length) {
    const place = [
      listing.location_district,
      listing.locality,
      listing.city,
      listing.location_address,
    ]
      .filter(Boolean)
      .join(' ');
    if (!overlapsText(place, alert.districts)) return { ok: false };
  }

  const drop = num(listing.last_price_drop ?? listing.lastPriceDrop);
  const priority =
    Boolean(alert.price_drop_priority) && drop != null && drop >= Number(process.env.RADAR_PRICE_DROP_ALERT_MIN || 100_000);

  return {
    ok: true,
    reason: priority ? `Sleva ${Math.round(drop).toLocaleString('cs-CZ')} Kč` : 'Nový inzerát',
    priority,
  };
}
