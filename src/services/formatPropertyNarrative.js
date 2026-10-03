/**
 * Čtivý markdown výstup analýzy nemovitosti pro chat (ne suchý odráčkový seznam).
 */

function scoreEmoji(score) {
  if (score >= 70) return '🟢';
  if (score >= 50) return '🟡';
  return '🔴';
}

function ownerBlock(analysis) {
  const status = analysis.ownerAccess || 'unknown';
  const owner = analysis.owner;
  const nahlizeniUrl = 'https://nahlizeni.cuzk.cz/';

  if (
    status === 'credentials' &&
    owner &&
    !analysis.isTestOwner &&
    !String(owner).includes('WSDP') &&
    !String(owner).includes('Vyžaduje')
  ) {
    return `### 👤 Vlastník a list vlastnictví\n\n**LV:** ${analysis.lv || '—'}\n\n**Vlastník:** ${owner}${
      analysis.risks?.hasMortgage ? '\n\n⚠️ Na LV je evidováno zástavní právo — ověřte před transakcí.' : ''
    }${analysis.risks?.hasExecution ? '\n\n🔴 **Pozor:** evidovaná exekuce.' : ''}`;
  }

  if (status === 'test' || analysis.isTestOwner) {
    return `### 👤 Vlastník a LV — vyžaduje produkční WSDP\n\n**Skutečný vlastník a číslo LV v této odpovědi záměrně neuvedeme.**\n\nBěžíte v testovacím režimu GeoPas (\`GEOPAS_WSDP_TEST=true\`), který vrací **stejnou fiktivní ukázku LV pro každou parcelu**. Kdybychom jméno zobrazili, vypadalo by jako realita — a to makléře spíš zmátne.\n\n**Katastr u této adresy je správně:** ${analysis.ku || '—'} · ${analysis.area || '—'}\n\n**Pro skutečné údaje:**\n1. Vyžádejte u GeoPas **WSDP login a heslo** (\`GEOPAS_WSDP_LOGIN\` / \`GEOPAS_WSDP_PASSWORD\`).\n2. V \`.env\` nastavte \`GEOPAS_WSDP_TEST=false\`, restart backendu.\n3. Dočasně ručně: [Nahlížení do katastru](${nahlizeniUrl}) — parcela ${analysis.cadastre?.landNumber || '—'}.`;
  }

  if (owner && !String(owner).includes('WSDP') && !String(owner).includes('Vyžaduje')) {
    return `### 👤 Vlastník a list vlastnictví\n\n**LV:** ${analysis.lv || '—'}\n\n**Vlastník:** ${owner}`;
  }

  const tech = analysis.wsdpError
    ? `\n\n**Technická chyba:** ${analysis.wsdpError}${analysis.wsdpHint ? `\n\n*${analysis.wsdpHint}*` : ''}`
    : '';
  return `### 👤 Vlastník a list vlastnictví\n\nEndpoint **wsdpLvByLand** máte v GeoPas zapnutý, ale k volání potřebujete ještě **WSDP login a heslo** (jiné než API token \`GEOPAS_API_KEY\`).${tech}\n\n**Co udělat:**\n1. V e-mailu od GeoPas najít WSDP přihlašovací údaje, nebo je vyžádat.\n2. Do \`nemio-backend/.env\`: \`GEOPAS_WSDP_LOGIN\`, \`GEOPAS_WSDP_PASSWORD\`, restart backendu.\n3. Dočasně ručně: [nahlizeni.cuzk.cz](${nahlizeniUrl}) (LV k ${analysis.ku || 'parcele'}).\n\n**Bez WSDP už funguje:** parcela, výměra, záplavy, hluk, okolí.`;
}

export function buildEngagingPropertyMarkdown(analysis) {
  if (!analysis) return '';

  if (analysis.notFound || analysis.errorCode === 'NOT_FOUND') {
    return `
## Nemovitost nenalezena

GeoPas nenašel shodu pro **${analysis.query || analysis.address || 'váš dotaz'}**.

**Co zkusit:**
- Obec + číslo popisné (např. \`Lískovec 537\`)
- Ulice + město (např. \`Mánesova 12, Ostrava\`)
- Parcela + k.ú. (např. \`2201/1 Vinohrady\`)

Bez přesnější lokalizace neumím načíst katastr, LV ani rizika.
`.trim();
  }

  const s = analysis.safetyScore || {};
  const score = s.score ?? '—';
  const emoji = typeof score === 'number' ? scoreEmoji(score) : '📊';
  const risks = (analysis.risks?.summary || []).join(' · ') || 'bez výrazných rizik v dostupných registrech';
  const schools = analysis.amenities?.schools?.length ?? 0;
  const transit = analysis.amenities?.transit?.length ?? 0;
  const health = analysis.amenities?.health?.length ?? 0;
  const flood = analysis.risks?.flood || 'nezjištěno';
  const realistic = analysis.valuation?.realistic || '—';

  const noiseLine = analysis.noise?.bands?.length
    ? `V okolí parcely jsou mapována **${analysis.noise.bands.length} pásma hluku** (aglomerace) — detail v modalu analýzy.`
    : analysis.localityProfile?.noiseFeel === 'tiche'
      ? 'Oficiální mapa hluku tady nic nevrátila (typické mimo aglomerace). **Podle profilu lokality** jde spíš o **klidnější místo** — ověřte na místě (silnice, hospoda, provoz).'
      : 'Data o hluku v lokalitě nebyla vrácena (mapa hluku často nepokrývá malé obce).';

  const localityBlock = analysis.localityProfileLine
    ? `\n${analysis.localityProfileLine}\n`
    : analysis.localityProfile
      ? `\n**Profil lokality:** ${analysis.localityProfile.vibe || '—'} · ${analysis.localityProfile.notes || ''}\n`
      : '';

  const tip = s.marketingTip || s.strategy || '';
  const cacheNote = analysis.fromCache
    ? `> ⚡ **Okamžitá odpověď z cache**${
        analysis.cacheAgeMinutes != null ? ` (data stará ${analysis.cacheAgeMinutes} min)` : ''
      } — pro čerstvá data z GeoPas použijte obnovení analýzy.\n\n`
    : '';

  const scorePartial =
    analysis.dataQuality?.fields?.safetyScore?.status === 'partial' ||
    (!analysis.municipality?.crime && analysis.dataQuality?.overall === 'partial');
  const scoreHonesty = scorePartial
    ? `\n\n> ℹ️ **Safety Score je částečný** — chybí oficiální data o kriminalitě/socioekonomice obce. Skóre stojí hlavně na vybavenosti a dostupných rizicích; neberte ho jako hotový verdikt lokality.`
    : '';

  const qualityLine = analysis.dataQuality?.summary
    ? `\n\n*Kvalita dat: ${analysis.dataQuality.summary}*`
    : '';

  return `
${cacheNote}## 🏠 ${analysis.address || 'Nemovitost'}

> ${emoji} **Safety score ${score}/100** — ${s.label || 'lokalita'} · ${s.targetBuyer || 'obecný profil'}${scoreHonesty}

${analysis.ku ? `**Katastr:** ${analysis.ku} · **Výměra:** ${analysis.area || '—'}` : ''}

---

### 📍 Lokalita a okolí
${localityBlock}
${noiseLine}

- **Záplavy:** ${flood}
- **Okolí (GeoPas):** ${schools} škol, ${transit} zastávek MHD, ${health} zdravotních zařízení v dosahu
- **Rizika v registrech:** ${risks}

${ownerBlock(analysis)}

---

### 💰 Orientační ocenění

| Scénář | Cena |
|--------|------|
| Optimistický | ${analysis.valuation?.optimistic || '—'} |
| **Realistický** | **${realistic}** |
| Pesimistický | ${analysis.valuation?.pessimistic || '—'} |

*${analysis.valuation?.note || ''}*

${tip ? `\n**💡 Tip pro makléře:** ${tip}` : ''}
${qualityLine}

---

*Zdroj: ${analysis.dataSource || 'GeoPas'} · ${analysis.fetchedAt ? new Date(analysis.fetchedAt).toLocaleString('cs-CZ') : 'právě teď'}*
`.trim();
}
