/**
 * OpenSanctions Match API — sankce + PEP screening.
 * https://www.opensanctions.org/docs/api/
 */

function extractTopics(hit) {
  const props = hit?.properties || hit?.entity?.properties || {};
  const topics = props.topics || props.topic || [];
  return (Array.isArray(topics) ? topics : [topics]).map((t) => String(t || '').toLowerCase());
}

function extractDatasets(hit) {
  const ds = hit?.datasets || hit?.dataset || hit?.entity?.datasets || [];
  return (Array.isArray(ds) ? ds : [ds]).map((d) => String(d || '').toLowerCase());
}

function classifyHit(hit) {
  const topics = extractTopics(hit);
  const datasets = extractDatasets(hit);
  const blob = [...topics, ...datasets, String(hit?.caption || '').toLowerCase()].join(' ');

  const isPep =
    topics.some((t) => t.includes('pep') || t.includes('role.pep') || t.includes('polit')) ||
    datasets.some((d) => d.includes('pep')) ||
    /\bpep\b/.test(blob);

  const isSanctioned =
    topics.some((t) =>
      /sanction|crime\.terror|debarment|export\.control|wanted|poi/.test(t),
    ) ||
    datasets.some((d) =>
      /ofac|sanctions|eu_fsf|un_sc|uk_sanctions|ch_seco|au_dfat|ca_dfatd/.test(d),
    ) ||
    /sanction/.test(blob);

  return { isPep, isSanctioned };
}

/**
 * @param {{ name: string, birthDate?: string, nationality?: string, clientType?: string }} input
 */
export async function screenOpenSanctions({
  name = '',
  birthDate = '',
  nationality = 'cz',
  clientType = 'natural_person',
} = {}) {
  const qName = String(name || '').trim();
  if (!qName) {
    return {
      passed: false,
      detail: 'OpenSanctions: chybí jméno — screening neproběhl.',
      source: 'opensanctions',
      matches: 0,
      topScore: 0,
      classification: 'incomplete',
      isPep: false,
      isSanctioned: false,
      hits: [],
    };
  }

  const apiKey = String(process.env.OPENSANCTIONS_API_KEY || '').trim();
  if (!apiKey) {
    return {
      passed: false,
      detail: 'OpenSanctions: API klíč není nastaven.',
      source: 'opensanctions',
      matches: 0,
      topScore: 0,
      classification: 'incomplete',
      isPep: false,
      isSanctioned: false,
      hits: [],
    };
  }

  const schema = clientType === 'legal_entity' ? 'Company' : 'Person';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const payload = {
      queries: {
        q1: {
          schema,
          properties: {
            name: [qName],
            ...(schema === 'Person' && String(birthDate || '').trim()
              ? { birthDate: [String(birthDate).trim()] }
              : {}),
            ...(schema === 'Person' && String(nationality || '').trim()
              ? { nationality: [String(nationality).trim()] }
              : {}),
          },
        },
      },
    };

    // Auth jen v Authorization headeru (docs) — ne v URL
    const url = 'https://api.opensanctions.org/match/default';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `ApiKey ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? ' Neplatný nebo neaktivní OPENSANCTIONS_API_KEY — zkontrolujte klíč na opensanctions.org.'
          : '';
      return {
        passed: false,
        detail: `OpenSanctions nedostupné (${res.status}).${hint}`,
        source: 'opensanctions',
        matches: 0,
        topScore: 0,
        classification: 'incomplete',
        isPep: false,
        isSanctioned: false,
        hits: [],
      };
    }

    const data = await res.json().catch(() => ({}));
    const qResult = data?.responses?.q1 || {};
    const results = Array.isArray(qResult?.results)
      ? qResult.results
      : Array.isArray(data?.results)
        ? data.results
        : [];

    if (!results.length) {
      return {
        passed: true,
        detail: 'OpenSanctions: bez nálezu v sankcích / PEP.',
        source: 'opensanctions',
        matches: 0,
        topScore: 0,
        classification: 'clear',
        isPep: false,
        isSanctioned: false,
        hits: [],
      };
    }

    const strong = results.filter((r) => Number(r?.score || 0) >= 0.75);
    const toScan = strong.length ? strong : results.slice(0, 5);

    let isPep = false;
    let isSanctioned = false;
    const hits = toScan.map((hit) => {
      const flags = classifyHit(hit);
      if (flags.isPep) isPep = true;
      if (flags.isSanctioned) isSanctioned = true;
      return {
        caption:
          String(hit?.caption || hit?.name || hit?.entity?.caption || '').trim() || 'záznam',
        score: Number(hit?.score || 0),
        isPep: flags.isPep,
        isSanctioned: flags.isSanctioned,
        datasets: extractDatasets(hit).slice(0, 6),
        topics: extractTopics(hit).slice(0, 8),
      };
    });

    // Silná shoda bez jasného topic → ber jako sankční riziko (opatrnost)
    if (strong.length && !isPep && !isSanctioned) {
      isSanctioned = true;
    }

    const topScore = Number(results[0]?.score || 0);
    const highRisk = isSanctioned || (isPep && strong.length > 0);
    const classification = highRisk ? 'hit' : strong.length || isPep ? 'review' : 'clear';

    return {
      passed: !highRisk && classification !== 'incomplete',
      detail: highRisk
        ? `OpenSanctions: ${isSanctioned ? 'sankční shoda' : ''}${isSanctioned && isPep ? ' + ' : ''}${isPep ? 'PEP' : ''} (top score ${topScore.toFixed(2)}).`
        : isPep
          ? `OpenSanctions: možná PEP shoda — vyžaduje přezkum (score ${topScore.toFixed(2)}).`
          : `OpenSanctions: nízké shody (${results.length}) — doporučena manuální kontrola.`,
      source: 'opensanctions',
      matches: results.length,
      topScore,
      classification,
      isPep,
      isSanctioned,
      hits,
    };
  } catch (err) {
    clearTimeout(timeout);
    const isAbort = err?.name === 'AbortError';
    return {
      passed: false,
      detail: isAbort
        ? 'OpenSanctions timeout — screening neověřen.'
        : `OpenSanctions chyba: ${err?.message || 'neznámá'}`,
      source: 'opensanctions',
      matches: 0,
      topScore: 0,
      classification: 'incomplete',
      isPep: false,
      isSanctioned: false,
      hits: [],
    };
  }
}

export function isOpenSanctionsConfigured() {
  return Boolean(String(process.env.OPENSANCTIONS_API_KEY || '').trim());
}
