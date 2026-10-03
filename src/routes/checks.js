import { Router } from 'express';
import { XMLParser } from 'fast-xml-parser';

const router = Router();
const parser = new XMLParser({ ignoreAttributes: false });

const REJSTRIKY_URL = 'https://www.rejstriky.info/api/isir';
const USERNAME = process.env.REJSTRIKY_USERNAME;
const PASSWORD = process.env.REJSTRIKY_PASSWORD;

// ─── Pomocná funkce — volání rejstriky.info API ───────────────────────────────
async function callRejstriky(endpoint, params) {
  if (!USERNAME || !PASSWORD) {
    throw new Error('REJSTRIKY_USERNAME nebo REJSTRIKY_PASSWORD není nastaven v .env');
  }

  const body = new URLSearchParams({
    username: USERNAME,
    password: PASSWORD,
    ...params,
  });

  const res = await fetch(`${REJSTRIKY_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`Rejstriky.info API chyba: ${res.status}`);

  const xml = await res.text();
  const parsed = parser.parse(xml);

  const status = parsed?.request?.requestinfo?.status;
  if (status !== 0 && status !== '0') {
    throw new Error(parsed?.request?.requestinfo?.statustext || 'Neznámá chyba API');
  }

  return parsed?.request?.answer;
}

// ─── Interpretace výsledků ───────────────────────────────────────────────────
function interpretResults(subjects) {
  if (!subjects || subjects.length === 0) {
    return {
      found: false,
      riskLevel: 'clean',
      riskLabel: 'Bez záznamu',
      riskColor: 'green',
      summary: 'Osoba nebyla nalezena v insolvenčním rejstříku.',
      recommendation: 'Právně čisté. Lze pokračovat standardním postupem.',
      cases: [],
    };
  }

  const activeCases = subjects.filter((s) => {
    const st = (s.currentstatus || '').toLowerCase();
    return !st.includes('zastaveno') &&
      !st.includes('splněno') &&
      !st.includes('zrušeno') &&
      !st.includes('zamítnuto');
  });

  const hasActive = activeCases.length > 0;
  const totalCases = subjects.length;

  let riskLevel;
  let riskLabel;
  let riskColor;
  let recommendation;

  if (hasActive) {
    riskLevel = 'high';
    riskLabel = 'Aktivní insolvence';
    riskColor = 'red';
    recommendation = 'POZOR: Osoba má aktivní insolvenční řízení. Rezervaci směřujte výhradně do advokátní úschovy. Konzultujte s právníkem před podpisem smluv.';
  } else if (totalCases > 0) {
    riskLevel = 'medium';
    riskLabel = 'Historická insolvence';
    riskColor = 'amber';
    recommendation = 'Osoba měla v minulosti insolvenční řízení (nyní ukončeno). Doporučujeme zvýšenou obezřetnost a ověření aktuální finanční situace.';
  } else {
    riskLevel = 'clean';
    riskLabel = 'Bez záznamu';
    riskColor = 'green';
    recommendation = 'Právně čisté. Lze pokračovat standardním postupem.';
  }

  return {
    found: totalCases > 0,
    riskLevel,
    riskLabel,
    riskColor,
    summary: hasActive
      ? `Nalezeno ${activeCases.length} aktivní insolvenční řízení z celkem ${totalCases} záznamů.`
      : `Nalezeno ${totalCases} historických záznamů — všechna řízení jsou ukončena.`,
    recommendation,
    cases: subjects.map((s) => ({
      name: s.n || `${s.firstname || ''} ${s.surname || ''}`.trim(),
      status: s.currentstatus || 'Neznámý stav',
      court: s.courtname || '—',
      caseNumber: `${s.spisprefix || 'INS'} ${s.spisnumber || ''}/${s.spisyear || ''}`.trim(),
      url: s.url || null,
      lastChange: s.lastmodification || null,
      address: s.address || null,
    })),
  };
}

// ─── POST /api/checks/insolvency ──────────────────────────────────────────────
router.post('/insolvency', async (req, res, next) => {
  try {
    const { name, firstName, surname, birthDate, rc } = req.body;

    if (!name && !firstName && !surname && !birthDate && !rc) {
      return res.status(400).json({
        error: 'Zadejte alespoň jméno, příjmení nebo rodné číslo osoby.',
      });
    }

    const params = {};
    if (rc) params.rc = rc.replace(/\//g, '');
    if (name) params.name = name;
    if (firstName) params.firstname = firstName;
    if (surname) params.surname = surname;
    if (birthDate) params.birthdate = birthDate;

    console.log(`[ISIR] Prověřuji: ${name || `${firstName || ''} ${surname || ''}`.trim()}`);

    const answer = await callRejstriky('getsubjects', params);

    let subjects = answer?.subjects?.subject;
    if (!subjects) subjects = [];
    if (!Array.isArray(subjects)) subjects = [subjects];

    const result = interpretResults(subjects);

    res.json({
      ...result,
      checkedAt: new Date().toISOString(),
      dataSource: 'ISIR via rejstriky.info',
      gdprNote: 'Prověření provedeno v rámci due diligence realitní transakce.',
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/checks/insolvency/quick ───────────────────────────────────────
router.post('/insolvency/quick', async (req, res, next) => {
  try {
    const { name, rc, surname } = req.body;
    if (!name && !rc && !surname) {
      return res.status(400).json({ error: 'Chybí jméno nebo RČ.' });
    }

    const params = {};
    if (rc) params.rc = rc.replace(/\//g, '');
    if (name) params.name = name;
    if (surname) params.surname = surname;

    const answer = await callRejstriky('hasrecord', params);
    const hasRecord = String(answer?.hasrecord).trim().toLowerCase() === 'true';

    res.json({
      hasRecord,
      riskColor: hasRecord ? 'red' : 'green',
      label: hasRecord ? 'Záznam v ISIR' : 'Bez záznamu',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
