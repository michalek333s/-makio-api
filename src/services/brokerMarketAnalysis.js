/**
 * Makléřská analýza nabídek — medián, srovnání, tipy.
 */

function fmtPrice(n) {
  if (!n || !Number.isFinite(n)) return '—';
  return `${new Intl.NumberFormat('cs-CZ').format(Math.round(n))} Kč`;
}

function fmtSqm(n) {
  if (!n || !Number.isFinite(n)) return '—';
  return `${new Intl.NumberFormat('cs-CZ').format(Math.round(n))} Kč/m²`;
}

export function medianPrice(listings) {
  const prices = listings.map((l) => l.price).filter((p) => p && p > 100_000).sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
}

export function buildBrokerMarketBrief(
  listings,
  { placeLabel, region, propertyType, totalInCache, cacheAsOf = null, liveUnavailable = false } = {},
) {
  const median = medianPrice(listings);
  const top = listings.slice(0, 5);
  const fsbo = listings.filter((l) => !l.isAgencyListing);

  let asOfLabel = '';
  if (cacheAsOf) {
    try {
      asOfLabel = new Date(cacheAsOf).toLocaleString('cs-CZ', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      asOfLabel = String(cacheAsOf).slice(0, 16);
    }
  }

  const lines = [
    `**${placeLabel} — tržní přehled (${propertyType})**`,
    '',
    liveUnavailable
      ? `Pracuji s **historickou cache**` +
        (asOfLabel ? ` z **${asOfLabel}**` : '') +
        ` — živá inzerce teď není dostupná.`
      : `Mám **${listings.length}** relevantních tipů z cache (celkem ${totalInCache} inzerátů v ${region})` +
        (asOfLabel ? `, snapshot **${asOfLabel}**` : '') +
        `.`,
    median
      ? `${liveUnavailable ? 'Historický medián' : 'Medián'} nabízených cen: **${fmtPrice(median)}**.`
      : '',
    '',
  ].filter((l, i, arr) => !(l === '' && arr[i - 1] === ''));

  if (top.length >= 2) {
    lines.push('**Srovnání top nabídek:**', '');
    top.forEach((l, i) => {
      const diff =
        median && l.price
          ? Math.round(((l.price - median) / median) * 100)
          : null;
      const diffStr =
        diff != null
          ? diff < 0
            ? ` (**${Math.abs(diff)} % pod mediánem** — zajímavé pro náběr)`
            : diff > 10
              ? ` (+${diff} % nad mediánem — ověřit odůvodnění)`
              : ` (blízko mediánu)`
          : '';
      lines.push(
        `${i + 1}. **${l.title || 'Inzerát'}** — ${fmtPrice(l.price)} · ${l.locality || '—'}` +
          (l.pricePerSqm ? ` · ${fmtSqm(l.pricePerSqm)}` : '') +
          diffStr,
      );
    });
    lines.push('');
  }

  const best = top[0];
  if (best) {
    const reasons = best.ai?.reasons?.join(', ') || (best.isAgencyListing ? 'RK' : 'soukromník');
    lines.push('**Moje doporučení (priorita náběru):**');
    lines.push(
      `→ **${best.title || 'První tip'}** (${fmtPrice(best.price)}) — ${reasons}.` +
        ` Skóre příležitosti **${best.ai?.score ?? '—'}/100**.`,
    );
    if (fsbo.length >= 2) {
      lines.push(
        `→ V regionu je **${fsbo.length}** soukromníků bez RK — ideální pro přímý kontakt a rychlejší obchod.`,
      );
    }
    lines.push('');
  }

  lines.push(
    '**Co dál?** Můžu porovnat s konkrétním klientem z CRM, spočítat výnos, nebo otevřít detail v Radaru.',
  );

  return lines.join('\n');
}
