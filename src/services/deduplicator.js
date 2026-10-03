/**
 * Deduplikace stejné nemovitosti napříč portály (GPS + cena + plocha).
 */

function gpsDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function areDuplicates(a, b) {
  let matchCount = 0;

  if (a.lat && b.lat) {
    const dist = gpsDistance(a.lat, a.lon, b.lat, b.lon);
    if (dist < 80) matchCount++;
  }

  if (a.price && b.price) {
    const priceDiff = Math.abs(a.price - b.price) / Math.max(a.price, b.price);
    if (priceDiff < 0.08) matchCount++;
  }

  if (a.floorArea && b.floorArea) {
    const areaDiff = Math.abs(a.floorArea - b.floorArea);
    if (areaDiff <= 5) matchCount++;
  }

  if (!a.lat && !b.lat && a.price && b.price && a.floorArea && b.floorArea) {
    const priceDiff = Math.abs(a.price - b.price) / Math.max(a.price, b.price);
    const areaDiff = Math.abs(a.floorArea - b.floorArea);
    if (priceDiff < 0.05 && areaDiff <= 3) return true;
  }

  return matchCount >= 2;
}

const SOURCE_PRIORITY = {
  bezrealitky: 1,
  facebook: 2,
  facebook_marketplace: 2,
  bazos: 3,
  sreality: 4,
};

/**
 * @param {Array<object>} allListings
 * @returns {Array<object>}
 */
export function deduplicateListings(allListings) {
  const groups = [];
  const visited = new Set();

  for (let i = 0; i < allListings.length; i++) {
    if (visited.has(i)) continue;

    const group = [i];
    visited.add(i);

    for (let j = i + 1; j < allListings.length; j++) {
      if (visited.has(j)) continue;
      if (areDuplicates(allListings[i], allListings[j])) {
        group.push(j);
        visited.add(j);
      }
    }

    groups.push(group);
  }

  return groups.map((group) => mergeDuplicateGroup(group.map((idx) => allListings[idx])));
}

/** Sloučí duplicity — RK signál z libovolného portálu má prioritu nad FSBO z Bazoše/FB. */
function mergeDuplicateGroup(members) {
  members.sort(
    (a, b) => (SOURCE_PRIORITY[a.source] || 99) - (SOURCE_PRIORITY[b.source] || 99),
  );

  const winner = { ...members[0] };
  const dupes = members.slice(1);
  const sources = [...new Set(members.map((m) => m.source))];

  const agencyMember = members.find((m) => m.isAgencyListing);
  if (agencyMember) {
    winner.isAgencyListing = true;
    winner.agencyName = agencyMember.agencyName || winner.agencyName;
    winner.sellerType = agencyMember.sellerType || winner.sellerType;
    winner.listingKind = agencyMember.listingKind || winner.listingKind;
    if (!agencyMember.fsboSignal) winner.fsboSignal = false;
  }

  const maxDays = Math.max(...members.map((m) => m.daysOnPortal ?? 0));
  if (maxDays > 0) {
    winner.daysOnPortal = maxDays;
    winner.daysTracked = maxDays;
  }

  const srealityMember = members.find((m) => m.source === 'sreality');
  if (srealityMember?.url) {
    winner.url = srealityMember.url;
    if ((srealityMember.imageUrls?.length ?? 0) > (winner.imageUrls?.length ?? 0)) {
      winner.imageUrls = srealityMember.imageUrls;
      winner.imageUrl = srealityMember.imageUrl;
    }
  }

  return {
    ...winner,
    foundOnPortals: sources,
    duplicateCount: dupes.length,
    duplicateUrls: dupes.map((d) => d.url).filter(Boolean),
    multiPortalBonus: dupes.length > 0,
  };
}
