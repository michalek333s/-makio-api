/**
 * Oficiální ARES REST API — ekonomické subjekty podle IČO.
 * https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}
 */

function cleanIco(ico) {
  return String(ico || '').replace(/\s+/g, '').trim();
}

const PRAVNI_FORMA = {
  101: 'Podnikající FO neuvedená v OR',
  102: 'Podnikající FO zapsaná v OR',
  105: 'Společnost s ručením omezeným',
  111: 'Veřejná obchodní společnost',
  112: 'Komanditní společnost',
  113: 'Společnost s ručením omezeným',
  116: 'Ústav',
  117: 'Nadační fond',
  118: 'Nadace',
  121: 'Akciová společnost',
  141: 'Obecně prospěšná společnost',
  145: 'Společenství vlastníků jednotek',
  205: 'Družstvo',
  301: 'Státní podnik',
  325: "Organizační složka státu",
  331: 'Příspěvková organizace',
  421: 'Zahraniční osoba',
  501: 'Odštěpný závod',
  601: 'Vysoká škola',
  641: 'Škola / školské zařízení',
  661: 'Veřejná výzkumná instituce',
  701: 'Sdružení',
  706: 'Spolek',
  736: 'Pobočný spolek',
};

function pickSidlo(subjekt) {
  const s = subjekt?.sidlo || subjekt?.adresaDorucovaci || {};
  if (s.textovaAdresa) return String(s.textovaAdresa).trim();
  const street = [s.nazevUlice || s.ulice, [s.cisloDomovni, s.cisloOrientacni].filter(Boolean).join('/')].filter(Boolean).join(' ');
  const city = [s.psc, s.nazevObce || s.obec].filter(Boolean).join(' ');
  return [street, city].filter(Boolean).join(', ') || null;
}

function pickStatutarni(subjekt) {
  const raw =
    subjekt?.statutarniOrgany ||
    subjekt?.angazovaneOsoby ||
    subjekt?.clenoveStatutarnihoOrganu ||
    [];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((o) => {
      const name =
        o?.nazev ||
        o?.obchodniJmeno ||
        [o?.jmeno, o?.prijmeni].filter(Boolean).join(' ') ||
        o?.clen?.nazev ||
        '';
      const role = o?.funkce || o?.typAngazma || o?.clenstvi || '';
      return { name: String(name).trim(), role: String(role).trim() };
    })
    .filter((x) => x.name);
}

function titleCaseName(s) {
  return String(s || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function personFromFo(fo) {
  if (!fo) return null;
  const name = titleCaseName([fo.jmeno, fo.prijmeni].filter(Boolean).join(' '));
  if (!name) return null;
  return {
    name,
    birthDate: fo.datumNarozeni ? String(fo.datumNarozeni).slice(0, 10) : null,
    nationality: fo.statniObcanstvi || null,
  };
}

function parsePodilPct(podilArr) {
  const list = Array.isArray(podilArr) ? podilArr : podilArr ? [podilArr] : [];
  for (const p of list) {
    const velikost = p?.velikostPodilu;
    if (!velikost) continue;
    const typ = String(velikost.typObnos || '').toUpperCase();
    const raw = String(velikost.hodnota || '').replace(',', '.');
    if (typ.includes('ZLOMEK') || raw.includes(';')) {
      const [a, b] = raw.split(';').map((x) => Number(x));
      if (b && Number.isFinite(a) && Number.isFinite(b) && b !== 0) {
        return Math.round((a / b) * 1000) / 10;
      }
    }
    if (typ.includes('PROCENT')) {
      const n = Number(raw.split(';')[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  const splaceni = list[0]?.splaceni;
  if (splaceni && String(splaceni.typObnos || '').toUpperCase().includes('PROCENT')) {
    const n = Number(String(splaceni.hodnota || '').split(';')[0].replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Obchodní rejstřík (VR) — jednatelé + společníci (pro UBO odhad).
 * @param {string} ico
 */
async function fetchAresVrEnrichment(ico) {
  const url = `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty-vr/${encodeURIComponent(ico)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return { statutarniOrgany: [], spolecnici: [], zpusobJednani: null };

  const data = await res.json();
  const zaznam = Array.isArray(data?.zaznamy)
    ? data.zaznamy.find((z) => z?.primarniZaznam) || data.zaznamy[0]
    : null;
  if (!zaznam) return { statutarniOrgany: [], spolecnici: [], zpusobJednani: null };

  const organs = [];
  for (const org of Array.isArray(zaznam.statutarniOrgany) ? zaznam.statutarniOrgany : []) {
    for (const clen of Array.isArray(org?.clenoveOrganu) ? org.clenoveOrganu : []) {
      // přeskoč vymazané
      if (clen?.datumVymazu) continue;
      const person = personFromFo(clen?.fyzickaOsoba);
      if (!person) continue;
      const role =
        clen?.clenstvi?.funkce?.nazev ||
        clen?.nazevAngazma ||
        org?.nazevOrganu ||
        'Jednatel';
      organs.push({
        name: person.name,
        role: String(role).trim(),
        birthDate: person.birthDate,
        nationality: person.nationality,
      });
    }
  }

  const spolecnici = [];
  for (const block of Array.isArray(zaznam.spolecnici) ? zaznam.spolecnici : []) {
    for (const s of Array.isArray(block?.spolecnik) ? block.spolecnik : []) {
      if (s?.datumVymazu) continue;
      const person = personFromFo(s?.osoba?.fyzickaOsoba);
      const poName = s?.osoba?.pravnickaOsoba?.obchodniJmeno || s?.osoba?.pravnickaOsoba?.nazev;
      const name = person?.name || (poName ? String(poName).trim() : '');
      if (!name) continue;
      const pct = parsePodilPct(s?.podil);
      spolecnici.push({
        name,
        birthDate: person?.birthDate || null,
        sharePercent: pct,
        label:
          pct != null
            ? `${name} (${pct % 1 === 0 ? pct : pct.toFixed(1)} % vlastnický podíl)`
            : name,
      });
    }
  }

  const zj = zaznam?.zpusobRizeni || zaznam?.statutarniOrgany?.[0]?.zpusobJednani;
  let zpusobJednani = null;
  if (Array.isArray(zj) && zj[0]?.hodnota) zpusobJednani = String(zj[0].hodnota);
  else if (typeof zj === 'string') zpusobJednani = zj;

  return { statutarniOrgany: organs, spolecnici, zpusobJednani };
}

/**
 * @param {string} ico
 */
export async function verifyAresByIco(ico) {
  const clean = cleanIco(ico);
  if (!/^\d{8}$/.test(clean)) {
    throw Object.assign(new Error('IČO musí mít 8 číslic'), { status: 400, code: 'INVALID_ICO' });
  }

  const url = `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${encodeURIComponent(clean)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });

  if (res.status === 404) {
    return {
      found: false,
      ico: clean,
      obchodniJmeno: null,
      pravniForma: null,
      sidlo: null,
      statutarniOrgany: [],
      spolecnici: [],
      beneficialOwnerSuggestion: null,
      representativeSuggestion: null,
      raw: null,
    };
  }

  if (!res.ok) {
    throw Object.assign(new Error(`ARES nedostupné (${res.status})`), {
      status: 502,
      code: 'ARES_HTTP',
    });
  }

  const data = await res.json();
  const formaRaw = data?.pravniForma;
  const formaKod =
    typeof formaRaw === 'object' ? String(formaRaw?.kod || '').trim() : String(formaRaw || '').trim();
  const formaNazev =
    (typeof formaRaw === 'object' && formaRaw?.nazev) ||
    PRAVNI_FORMA[formaKod] ||
    formaKod ||
    null;

  let vr = { statutarniOrgany: [], spolecnici: [], zpusobJednani: null };
  try {
    vr = await fetchAresVrEnrichment(clean);
  } catch (e) {
    console.warn('[ARES VR]', e?.message || e);
  }

  const statutarniOrgany =
    vr.statutarniOrgany.length > 0 ? vr.statutarniOrgany : pickStatutarni(data);

  const firstOrgan = statutarniOrgany[0] || null;
  const representativeSuggestion = firstOrgan
    ? {
        name: firstOrgan.role ? `${firstOrgan.name}, ${firstOrgan.role.toLowerCase()}` : firstOrgan.name,
        birthDate: firstOrgan.birthDate || null,
        role: firstOrgan.role || null,
      }
    : null;

  const beneficialOwnerSuggestion =
    vr.spolecnici.length > 0
      ? vr.spolecnici.map((s) => s.label).join('; ')
      : null;

  return {
    found: true,
    ico: clean,
    obchodniJmeno: String(data?.obchodniJmeno || data?.nazev || '').trim() || null,
    pravniForma: formaNazev ? String(formaNazev).trim() : null,
    pravniFormaKod: formaKod || null,
    sidlo: pickSidlo(data),
    datumVzniku: data?.datumVzniku || null,
    dic: data?.dic || null,
    statutarniOrgany,
    spolecnici: vr.spolecnici,
    zpusobJednani: vr.zpusobJednani,
    representativeSuggestion,
    beneficialOwnerSuggestion,
    raw: {
      ico: data?.ico,
      obchodniJmeno: data?.obchodniJmeno,
      pravniForma: data?.pravniForma,
      sidlo: data?.sidlo,
    },
  };
}

function mapAresHit(item) {
  const ico = cleanIco(item?.ico);
  const formaRaw = item?.pravniForma;
  const formaKod =
    typeof formaRaw === 'object' ? String(formaRaw?.kod || '').trim() : String(formaRaw || '').trim();
  const formaNazev =
    (typeof formaRaw === 'object' && formaRaw?.nazev) ||
    PRAVNI_FORMA[formaKod] ||
    formaKod ||
    null;
  return {
    ico: /^\d{8}$/.test(ico) ? ico : null,
    obchodniJmeno: String(item?.obchodniJmeno || item?.nazev || '').trim() || null,
    pravniForma: formaNazev ? String(formaNazev).trim() : null,
    sidlo: pickSidlo(item),
  };
}

/**
 * Našeptávač — hledání subjektů podle obchodního jména (ARES REST POST /vyhledat).
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 */
export async function searchAresByName(query, { limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 3) {
    return { query: q, results: [], truncated: false };
  }

  const max = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const url = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/vyhledat';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      obchodniJmeno: q,
      start: 0,
      pocet: max,
    }),
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    throw Object.assign(new Error(`ARES nedostupné (${res.status})`), {
      status: 502,
      code: 'ARES_HTTP',
    });
  }

  const data = await res.json();
  const items = Array.isArray(data?.ekonomickeSubjekty) ? data.ekonomickeSubjekty : [];
  const results = items.map(mapAresHit).filter((r) => r.ico && r.obchodniJmeno);
  const total = Number(data?.pocetCelkem) || results.length;

  return {
    query: q,
    results,
    truncated: total > results.length,
    total,
  };
}
