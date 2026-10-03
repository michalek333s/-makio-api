/**
 * Parsování odpovědi wsdpLvByLand (base64 XML výpis LV z ČÚZK).
 */

function tagValue(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function parseSubjects(xml) {
  const owners = [];
  const blockRe = /<SUBJEKT>([\s\S]*?)<\/SUBJEKT>/gi;
  let m;
  while ((m = blockRe.exec(xml))) {
    const block = m[1];
    const prijmeni = tagValue(block, 'prijmeni');
    const jmeno = tagValue(block, 'jmeno');
    const nazev = tagValue(block, 'nazev');
    const name =
      [jmeno, prijmeni].filter(Boolean).join(' ').trim() ||
      nazev ||
      null;
    if (name) owners.push(name);
  }
  return [...new Set(owners)];
}

function parseLiensFromXml(xml) {
  const liens = [];
  const lower = xml.toLowerCase();
  if (/exekuc/i.test(xml)) {
    liens.push({ type: 'Exekuce', note: 'Evidováno v XML LV' });
  }
  if (/zastavn/i.test(xml) || /zástavn/i.test(xml)) {
    liens.push({ type: 'Zástavní právo', note: 'Evidováno v XML LV' });
  }
  const jpvRe = /<JPV[^>]*>([\s\S]*?)<\/JPV>/gi;
  let jpv;
  while ((jpv = jpvRe.exec(xml))) {
    const popis = tagValue(jpv[1], 'POPIS') || tagValue(jpv[1], 'popis');
    if (popis && !liens.some((l) => l.note === popis)) {
      liens.push({ type: 'Zápis na LV', note: popis.slice(0, 120) });
    }
  }
  return liens.slice(0, 8);
}

export function parseWsdpLvPayload(raw, { isTestSample = false } = {}) {
  if (!raw) return null;

  if (raw.base64EncodedFile) {
    const xml = Buffer.from(raw.base64EncodedFile, 'base64').toString('utf8');
    const lv = tagValue(xml, 'CISLO_LV');
    const owners = parseSubjects(xml);
    const liens = parseLiensFromXml(xml);
    return {
      lv_number: lv,
      lv,
      owner: owners[0] || null,
      owners: owners.map((name) => ({ name })),
      liens,
      isTestSample,
      rawXmlLength: xml.length,
    };
  }

  return raw;
}
