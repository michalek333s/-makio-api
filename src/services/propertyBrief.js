/**
 * Textové shrnutí analýzy pro AI chat a rychlý náhled v UI.
 */

export function formatPropertyBrief(analysis) {
  if (!analysis) return '';

  if (analysis.notFound || analysis.errorCode === 'NOT_FOUND') {
    return `GeoPas nenašel **${analysis.query || analysis.address || 'lokalitu'}**. Zkuste obec + č.p. nebo parcelu + k.ú.`;
  }

  const schools = analysis.amenities?.schools?.length ?? 0;
  const transit = analysis.amenities?.transit?.length ?? 0;
  const risks = (analysis.risks?.summary || []).join('; ') || '—';
  const score = analysis.safetyScore?.score ?? '—';
  const scoreLabel = analysis.safetyScore?.label ?? '';
  const isTest = analysis.isTestOwner || analysis.ownerAccess === 'test';
  const ownerLine = isTest
    ? '• LV / vlastník: **vyžaduje produkční WSDP** (testovací režim — neukazujeme fiktivní jméno)'
    : analysis.ownerAccess === 'none'
      ? '• LV / vlastník: vyžaduje WSDP přístup od GeoPas'
      : `• LV: ${analysis.lv || '—'} | Vlastník: ${analysis.owner || '—'}`;

  const scoreMode = analysis.safetyScore?.mode;
  const scoreIsPartial =
    analysis.safetyScore?.isPartial ||
    scoreMode === 'amenities_only' ||
    scoreMode === 'partial' ||
    analysis.dataQuality?.fields?.safetyScore?.status === 'partial' ||
    analysis.dataQuality?.fields?.safetyScore?.status === 'incomplete';
  const partial =
    scoreMode === 'amenities_only'
      ? ' (jen vybavenost POI — neplný Safety Score)'
      : scoreIsPartial
        ? ' (částečný — bez oficiální kriminality obce)'
        : '';

  const scoreDisplay =
    scoreMode === 'amenities_only' && analysis.safetyScore?.score != null
      ? `${analysis.safetyScore.score} (vybavenost)`
      : `${score}/100`;

  const lines = [
    `**${analysis.address || 'Nemovitost'}**`,
    `• Katastr: ${analysis.ku}`,
    `• Výměra: ${analysis.area}`,
    ownerLine,
    `• Záplavy: ${analysis.risks?.flood || '—'}`,
    `• Rizika: ${risks}`,
    `• Okolí: ${schools} škol, ${transit} MHD v dosahu (GeoPas POI)`,
    `• Safety score: **${scoreDisplay}** ${scoreLabel ? `(${scoreLabel})` : ''}${partial}`,
    `• Odhad (orientační): ${analysis.valuation?.realistic || '—'}`,
  ];

  if (analysis.noise?.bands?.length) {
    lines.push(`• Hluk: data z mapy hluku (${analysis.noise.bands.length} pásem v okolí parcely)`);
  }
  if (analysis.localityProfileLine) {
    lines.push(`• ${analysis.localityProfileLine.replace(/\*\*/g, '')}`);
  } else if (analysis.localityProfile?.vibe) {
    lines.push(
      `• Profil lokality: ${analysis.localityProfile.vibe}${
        analysis.localityProfile.notes ? ` — ${analysis.localityProfile.notes}` : ''
      }`,
    );
  }
  if (analysis.dataQuality?.summary) {
    lines.push(`• Data: ${analysis.dataQuality.summary}`);
  }

  return lines.join('\n');
}

export function mergePropertyIntoChatResponse(existingResponse, brief, { error } = {}) {
  if (error) {
    const prefix = existingResponse?.trim() ? `${existingResponse.trim()}\n\n` : '';
    return `${prefix}⚠️ **GeoPas:** ${error}\n\nZkuste upřesnit adresu (ulice, město) nebo parcelu ve tvaru **číslo/k.ú.** (např. \`2201/1 Vinohrady\`).`;
  }
  if (!brief) return existingResponse || '';
  const prefix = existingResponse?.trim()
    ? `${existingResponse.trim()}\n\n---\n\n**Data z GeoPas:**\n\n`
    : '**Data z GeoPas:**\n\n';
  return `${prefix}${brief}`;
}
