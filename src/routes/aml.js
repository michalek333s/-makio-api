/**
 * AML routes — dočasný interní screening (OpenSanctions / EU / ARES / ISIR).
 * Ostré AML napojení: Merk (Imper) — API přijde v následujících dnech.
 * Do té doby tento modul neměnit směrem k produkčnímu OCR / compliance verdiktu.
 */

import { Router } from 'express';
import multer from 'multer';
import {
  getEuSanctionsCacheMeta,
  runEuSanctionsCheck,
  syncEuSanctionsCache,
} from '../services/euSanctions.js';
import { loadAmlCase, saveAmlCase, isAmlPersistConfigured } from '../services/amlCaseStore.js';
import { extractIdDocumentFields, isIdOcrConfigured } from '../services/idDocumentOcr.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function reqUserId(req) {
  return req.user?.id || req.authUser?.id || null;
}

async function getOrCreateCase(userId, clientId, clientName) {
  const id = String(clientId);
  const existing = await loadAmlCase(userId, id);
  if (existing) {
    if (clientName && existing.clientName !== clientName) {
      existing.clientName = clientName;
      existing.updatedAt = new Date().toISOString();
      await saveAmlCase(userId, existing);
    }
    return existing;
  }
  const created = defaultAmlForClient(id, clientName);
  await saveAmlCase(userId, created);
  return created;
}

async function persistCase(userId, amlCase) {
  amlCase.updatedAt = new Date().toISOString();
  return saveAmlCase(userId, amlCase);
}

async function runOpenSanctionsCheck({ name = '', birthDate = '', nationality = 'cz' }) {
  const qName = String(name || '').trim();
  if (!qName) {
    return {
      passed: false,
      detail: 'OpenSanctions: chybí jméno osoby/subjektu — screening neproběhl.',
      source: 'opensanctions',
      matches: 0,
      topScore: 0,
      classification: 'incomplete',
    };
  }

  const apiKey = String(process.env.OPENSANCTIONS_API_KEY || '').trim();
  if (!apiKey) {
    return {
      passed: false,
      detail: 'OpenSanctions: API klíč není nastaven — nelze potvrdit čistotu.',
      source: 'opensanctions',
      matches: 0,
      topScore: 0,
      classification: 'incomplete',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const payload = {
      queries: {
        q1: {
          schema: 'Person',
          properties: {
            name: [qName],
            ...(String(birthDate || '').trim() ? { birthDate: [String(birthDate || '').trim()] } : {}),
            ...(String(nationality || 'cz').trim() ? { nationality: [String(nationality || 'cz').trim()] } : {}),
          },
        },
      },
    };

    const url = `https://api.opensanctions.org/match/default?api_key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return {
        passed: false,
        detail: `OpenSanctions nedostupné (${res.status}) — screening neověřen.`,
        source: 'opensanctions',
        matches: 0,
        topScore: 0,
        classification: 'incomplete',
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
        detail: 'OpenSanctions: bez nálezu v sankcích/PEP.',
        source: 'opensanctions',
        matches: 0,
        topScore: 0,
        classification: 'clear',
      };
    }

    const topScore = Number(results[0]?.score || 0);
    const strongMatches = results.filter((r) => Number(r?.score || 0) >= 0.75);
    const highRisk = strongMatches.length > 0;

    const top = results[0] || {};
    const topLabel =
      String(top?.caption || '').trim() ||
      String(top?.name || '').trim() ||
      String(top?.entity?.caption || '').trim() ||
      'neznámý záznam';

    return {
      passed: !highRisk,
      detail: highRisk
        ? `OpenSanctions: nalezeno ${strongMatches.length} silných shod (top: ${topLabel}, score ${topScore.toFixed(2)}).`
        : `OpenSanctions: nalezeny nízké shody (${results.length}), doporučena manuální kontrola.`,
      source: 'opensanctions',
      matches: results.length,
      topScore,
      classification: highRisk ? 'hit' : 'review',
    };
  } catch (err) {
    clearTimeout(timeout);
    const isAbort = err?.name === 'AbortError';
    return {
      passed: false,
      detail: isAbort
        ? 'OpenSanctions timeout po 10s — screening neověřen.'
        : `OpenSanctions chyba: ${err?.message || 'neznámá chyba'} — screening neověřen.`,
      source: 'opensanctions',
      matches: 0,
      topScore: 0,
      classification: 'incomplete',
    };
  }
}

function normalizeForCompare(v) {
  return String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const REJSTRIKY_URL = 'https://www.rejstriky.info/api/isir';

async function runInsolvencyCheck({ name = '', rc = '', surname = '' } = {}) {
  const username = String(process.env.REJSTRIKY_USERNAME || '').trim();
  const password = String(process.env.REJSTRIKY_PASSWORD || '').trim();
  if (!username || !password) {
    return {
      passed: false,
      detail: 'ISIR: API přístup není nastaven — insolvenci nelze ověřit.',
      source: 'isir',
      hasRecord: null,
      classification: 'incomplete',
    };
  }

  const queryName = String(name || '').trim();
  const queryRc = String(rc || '').trim().replace(/\//g, '');
  const querySurname = String(surname || '').trim();
  if (!queryName && !queryRc && !querySurname) {
    return {
      passed: false,
      detail: 'ISIR: chybí jméno, příjmení nebo rodné číslo — kontrola neproběhla.',
      source: 'isir',
      hasRecord: null,
      classification: 'incomplete',
    };
  }

  try {
    const payload = new URLSearchParams({
      username,
      password,
      ...(queryRc ? { rc: queryRc } : {}),
      ...(queryName ? { name: queryName } : {}),
      ...(querySurname ? { surname: querySurname } : {}),
    });
    const response = await fetch(`${REJSTRIKY_URL}/hasrecord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
    });
    if (!response.ok) {
      return {
        passed: false,
        detail: `ISIR nedostupný (${response.status}) — insolvenci nelze ověřit.`,
        source: 'isir',
        hasRecord: null,
        classification: 'incomplete',
      };
    }

    const xml = await response.text();
    const hasRecord =
      /<hasrecord>\s*true\s*<\/hasrecord>/i.test(xml) ||
      /<hasrecord[^>]*>\s*1\s*<\/hasrecord>/i.test(xml);

    return {
      passed: !hasRecord,
      detail: hasRecord
        ? 'ISIR: nalezen záznam o insolvenci/exekuci, nutná ruční kontrola.'
        : 'ISIR: bez záznamu o insolvenci/exekuci.',
      source: 'isir',
      hasRecord,
      classification: hasRecord ? 'hit' : 'clear',
    };
  } catch (err) {
    return {
      passed: false,
      detail: `ISIR chyba: ${err?.message || 'neznámá chyba'} — insolvenci nelze ověřit.`,
      source: 'isir',
      hasRecord: null,
      classification: 'incomplete',
    };
  }
}

async function runAresCheck(clientName, propertyAddress = '') {
  const name = String(clientName || '').trim();
  if (!name) {
    return {
      passed: false,
      detail: 'ARES: chybí jméno/název subjektu — kontrola neproběhla.',
      source: 'ares',
      companyAddress: '',
      matchedByAddress: null,
      classification: 'incomplete',
    };
  }

  try {
    const url =
      `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty?obchodniJmeno=${encodeURIComponent(name)}`;
    const res = await fetch(url);
    if (!res.ok) {
      return {
        passed: true,
        detail: `ARES nedostupné (${res.status}), zkuste později.`,
        source: 'ares',
        companyAddress: '',
        matchedByAddress: null,
      };
    }

    const data = await res.json();
    const items = Array.isArray(data?.ekonomickeSubjekty) ? data.ekonomickeSubjekty : [];
    if (!items.length) {
      return {
        passed: true,
        detail: 'ARES: nebyl nalezen žádný ekonomický subjekt.',
        source: 'ares',
        companyAddress: '',
        matchedByAddress: null,
      };
    }

    const first = items[0] || {};
    const sidloObj = first?.sidlo || {};
    const sidlo =
      String(sidloObj?.textovaAdresa || '').trim() ||
      [sidloObj?.nazevUlice, sidloObj?.cisloDomovni, sidloObj?.nazevObce]
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .join(' ');

    const normalizedCompany = normalizeForCompare(sidlo);
    const normalizedProperty = normalizeForCompare(propertyAddress);
    const hasPropertyAddress = normalizedProperty.length > 0;
    const matchedByAddress =
      hasPropertyAddress &&
      normalizedCompany.length > 0 &&
      (normalizedCompany.includes(normalizedProperty) || normalizedProperty.includes(normalizedCompany));

    if (!hasPropertyAddress) {
      return {
        passed: true,
        detail: sidlo
          ? `ARES: nalezeno sídlo subjektu "${sidlo}".`
          : 'ARES: subjekt nalezen, ale bez textové adresy sídla.',
        source: 'ares',
        companyAddress: sidlo,
        matchedByAddress: null,
      };
    }

    if (matchedByAddress) {
      return {
        passed: true,
        detail: `ARES: sídlo subjektu odpovídá adrese nemovitosti (${sidlo || 'bez adresy'}).`,
        source: 'ares',
        companyAddress: sidlo,
        matchedByAddress: true,
      };
    }

    return {
      passed: false,
      detail: `ARES: sídlo subjektu (${sidlo || 'neuvedeno'}) se neshoduje s adresou nemovitosti.`,
      source: 'ares',
      companyAddress: sidlo,
      matchedByAddress: false,
    };
  } catch (err) {
    return {
      passed: true,
      detail: `ARES chyba: ${err?.message || 'neznámá chyba'}`,
      source: 'ares',
      companyAddress: '',
      matchedByAddress: null,
    };
  }
}

function buildExtractionFromCase(amlCase) {
  // Záměrně bez fiktivních OP čísel — simulované OCR je zakázané.
  return {
    state: 'idle',
    proposedFields: null,
    confidence: null,
    extractedAt: null,
    source: null,
    simulated: false,
    warning:
      'OCR spoštěte nahráním fotky OP (Vision). Bez AI klíče použijte ruční vyplnění + osobní identifikaci.',
    lastError: null,
  };
}

function mapOcrToLegacyExtraction(ocr) {
  const f = ocr?.fields || {};
  const name = String(f.full_name || '').trim();
  const [firstName = '', ...rest] = name.split(/\s+/);
  const lastName = rest.join(' ').trim();
  const conf = Number(ocr?.confidence) || 0;
  return {
    state: ocr?.usable ? 'ready' : 'failed',
    proposedFields: ocr?.usable
      ? {
          name,
          firstName,
          lastName,
          idCard: f.id_document || '',
          address_home: f.address || '',
          rc: f.rc || '',
          birthDate: f.birth_date || '',
        }
      : null,
    confidence: {
      name: conf,
      firstName: conf,
      lastName: lastName ? conf : 0.4,
      idCard: f.id_document ? conf : 0.2,
      address_home: f.address ? conf : 0.2,
      rc: f.rc ? conf : 0.2,
    },
    extractedAt: new Date().toISOString(),
    source: ocr?.source || 'vision',
    simulated: false,
    warning: ocr?.warning || null,
    lastError: ocr?.usable ? null : 'OCR nenačetlo údaje — vyplňte ručně.',
  };
}

function defaultAmlForClient(clientId, clientName = 'Klient') {
  return {
    caseId: `aml-${clientId}`,
    clientId: String(clientId),
    clientName,
    status: 'PENDING',
    statusMessage: 'AML spis nekompletní — doplňte identifikaci klienta',
    identificationComplete: false,
    screeningComplete: false,
    identificationMethod: null,
    registryChecks: [
      { name: 'Sankční seznamy (EU/OFAC)', passed: false, detail: 'Čeká na screening — zatím neověřeno' },
      { name: 'Politicky exponovaná osoba (PEP)', passed: false, detail: 'Čeká na screening — zatím neověřeno' },
      { name: 'Insolvence a exekuce (ISIR)', passed: false, detail: 'Čeká na screening — zatím neověřeno' },
      { name: 'EU Sanctions - lokální cache', passed: false, detail: 'Čeká na screening — zatím neověřeno' },
    ],
    aiWarning:
      'Projděte varovné body a doložte prohlášení o původu prostředků — pak můžete pokračovat ke smlouvě.',
    requiredActions: [
      'Fyzická identifikace klienta (OP)',
      'Screening v registrech (sankce, PEP, ISIR)',
      'Prohlášení o původu finančních prostředků',
      'Interní AML dotazník',
    ],
    completedActions: [],
    requiredDocuments: [
      { id: 'id-front', label: 'Občanský průkaz — přední strana (volitelné)', required: false },
      { id: 'id-back', label: 'Občanský průkaz — zadní strana (volitelné)', required: false },
      { id: 'aml-questionnaire', label: 'Interní AML dotazník', required: true },
      { id: 'source-funds', label: 'Prohlášení o původu finančních prostředků', required: true },
    ],
    documents: {},
    idExtraction: {
      state: 'idle',
      proposedFields: null,
      confidence: null,
      extractedAt: null,
      source: null,
      lastError: null,
      appliedAt: null,
    },
    updatedAt: new Date().toISOString(),
  };
}

function markIdentificationComplete(amlCase, method) {
  const completed = new Set(amlCase.completedActions || []);
  completed.add('Fyzická identifikace klienta (OP)');
  amlCase.completedActions = Array.from(completed);
  amlCase.identificationMethod = method;
  amlCase.identificationComplete = true;
}

function markScreeningComplete(amlCase) {
  const completed = new Set(amlCase.completedActions || []);
  completed.add('Screening v registrech (sankce, PEP, ISIR)');
  amlCase.completedActions = Array.from(completed);
  amlCase.screeningComplete = true;
}

async function runAllRegistryChecks({ name, rc, propertyAddress, birthDate, nationality }) {
  const [aresResult, openSanctionsResult, euSanctionsResult, insolvencyResult] = await Promise.all([
    runAresCheck(name, propertyAddress),
    runOpenSanctionsCheck({ name, birthDate, nationality }),
    runEuSanctionsCheck({ name }),
    runInsolvencyCheck({ name, rc }),
  ]);
  return { aresResult, openSanctionsResult, euSanctionsResult, insolvencyResult };
}

function mergeRegistryResults(amlCase, results) {
  const { aresResult, openSanctionsResult, euSanctionsResult, insolvencyResult } = results;
  const currentChecks = Array.isArray(amlCase.registryChecks) ? amlCase.registryChecks : [];
  const filteredChecks = currentChecks.filter(
    (c) =>
      c?.name !== 'ARES - Registr ekonomických subjektů' &&
      c?.name !== 'OpenSanctions - Sankce a PEP' &&
      c?.name !== 'EU Sanctions - lokální cache' &&
      c?.name !== 'Insolvence a exekuce (ISIR)',
  );
  amlCase.registryChecks = [
    ...filteredChecks,
    {
      name: 'ARES - Registr ekonomických subjektů',
      passed: !!aresResult.passed,
      detail: aresResult.detail,
      source: 'ares',
    },
    {
      name: 'OpenSanctions - Sankce a PEP',
      passed: !!openSanctionsResult.passed,
      detail: openSanctionsResult.detail,
      source: 'opensanctions',
    },
    {
      name: 'EU Sanctions - lokální cache',
      passed: !!euSanctionsResult.passed,
      detail: euSanctionsResult.detail,
      source: 'eu_sanctions',
    },
    {
      name: 'Insolvence a exekuce (ISIR)',
      passed: !!insolvencyResult.passed,
      detail: insolvencyResult.detail,
      source: 'isir',
    },
  ];

  if (
    aresResult.passed === false ||
    openSanctionsResult.passed === false ||
    euSanctionsResult.passed === false ||
    insolvencyResult.passed === false
  ) {
    amlCase.status = 'WARNING';
    amlCase.statusMessage =
      insolvencyResult.passed === false
        ? 'Nalezen záznam v ISIR — vyžaduje kontrolu makléře'
        : euSanctionsResult.passed === false
          ? 'Nalezena shoda v EU sanctions — vyžaduje kontrolu makléře'
          : openSanctionsResult.passed === false
            ? 'Nalezena shoda v OpenSanctions — vyžaduje kontrolu makléře'
            : 'Nalezena neshoda v ARES — vyžaduje kontrolu makléře';
  } else if (amlCase.identificationComplete) {
    amlCase.status = 'OK';
    amlCase.statusMessage = 'AML spis připraven k obchodu — finální schválení zůstává na RK';
  }
}

router.get('/client/:clientId', async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const clientName = String(req.query.clientName || '');
    const amlCase = await getOrCreateCase(reqUserId(req), clientId, clientName);
    res.json({
      ...amlCase,
      persist: isAmlPersistConfigured() ? 'supabase' : 'memory',
    });
  } catch (e) {
    next(e);
  }
});

router.post('/client/:clientId/toggle-action', async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const { action, clientName } = req.body || {};
    if (!String(action || '').trim()) {
      return res.status(400).json({ error: 'Chybí action.' });
    }

    const amlCase = await getOrCreateCase(reqUserId(req), clientId, clientName);
    const completed = new Set(amlCase.completedActions || []);
    if (completed.has(action)) completed.delete(action);
    else completed.add(action);
    amlCase.completedActions = Array.from(completed);
    await persistCase(reqUserId(req), amlCase);
    res.json(amlCase);
  } catch (e) {
    next(e);
  }
});

router.post('/client/:clientId/upload-document', upload.single('file'), async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const { documentId, clientName } = req.body || {};
    const file = req.file;

    if (!String(documentId || '').trim()) {
      return res.status(400).json({ error: 'Chybí documentId.' });
    }
    if (!file) {
      return res.status(400).json({ error: 'Chybí soubor.' });
    }

    const amlCase = await getOrCreateCase(reqUserId(req), clientId, clientName);
    amlCase.documents = {
      ...(amlCase.documents || {}),
      [documentId]: {
        uploaded: true,
        fileName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        uploadedAt: new Date().toISOString(),
        // Fotka se nepersistuje — jen metadata
      },
    };

    if (documentId === 'id-front' || documentId === 'id-back') {
      if (!isIdOcrConfigured()) {
        amlCase.idExtraction = {
          state: 'needs_manual',
          proposedFields: null,
          confidence: null,
          extractedAt: null,
          source: null,
          simulated: false,
          lastError:
            'OCR není nakonfigurované (OPENAI_API_KEY nebo GEMINI_API_KEY). Vyplňte údaje ručně a potvrďte osobní identifikaci.',
          warning: 'Bez Vision OCR nelze číst doklad automaticky.',
        };
      } else {
        try {
          const imageBase64 = file.buffer.toString('base64');
          const ocr = await extractIdDocumentFields({
            imageBase64,
            mimeType: file.mimetype || 'image/jpeg',
          });
          amlCase.idExtraction = mapOcrToLegacyExtraction(ocr);
        } catch (ocrErr) {
          amlCase.idExtraction = {
            state: 'failed',
            proposedFields: null,
            confidence: null,
            extractedAt: new Date().toISOString(),
            source: null,
            simulated: false,
            lastError: ocrErr.message || 'OCR selhalo',
            warning: 'Zkuste jinou fotku, nebo vyplňte údaje ručně.',
          };
        }
      }
    }

    await persistCase(reqUserId(req), amlCase);
    res.json(amlCase);
  } catch (e) {
    next(e);
  }
});

router.post('/client/:clientId/extract-id-data', async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const { clientName } = req.body || {};
    const amlCase = await getOrCreateCase(reqUserId(req), clientId, clientName);
    const hasFront = !!amlCase.documents?.['id-front']?.uploaded;
    const hasBack = !!amlCase.documents?.['id-back']?.uploaded;

    if (!hasFront && !hasBack) {
      return res.status(400).json({ error: 'Nejdřív nahrajte scan OP (přední nebo zadní stranu).' });
    }

    // OCR běží při uploadu (fotka se neukládá). extract jen vrátí poslední výsledek.
    if (amlCase.idExtraction?.state === 'ready' && amlCase.idExtraction?.proposedFields) {
      return res.json(amlCase);
    }

    if (amlCase.idExtraction?.simulated || amlCase.idExtraction?.source === 'ocr-simulated') {
      amlCase.idExtraction = buildExtractionFromCase(amlCase);
      await persistCase(reqUserId(req), amlCase);
    }

    return res.status(400).json({
      error:
        amlCase.idExtraction?.lastError ||
        'Automatické OCR neproběhlo. Nahrajte fotku znovu (s Vision klíčem), nebo vyplňte údaje ručně v AML Due Diligence.',
      code: 'AML_OCR_UNAVAILABLE',
      case: amlCase,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/client/:clientId/apply-id-data', async (req, res) => {
  const { clientId } = req.params;
  const {
    acceptedFields = [],
    fieldOverrides = {},
    clientName,
    propertyAddress = '',
    birthDate = '',
    nationality = 'cz',
    manualMode = false,
    inPersonVerified = false,
  } = req.body || {};
  const uid = reqUserId(req);
  const amlCase = await getOrCreateCase(uid, clientId, clientName);
  const extraction = amlCase.idExtraction;
  const isManual =
    manualMode === true ||
    (fieldOverrides &&
      typeof fieldOverrides === 'object' &&
      Object.keys(fieldOverrides).length > 0 &&
      (!extraction || extraction.state !== 'ready' || !extraction.proposedFields));

  try {
    const crmPatch = {};

    if (isManual) {
      if (!inPersonVerified) {
        return res.status(400).json({
          error: 'Potvrďte, že jste klienta identifikovali osobně podle platného dokladu totožnosti.',
        });
      }
      for (const [key, rawValue] of Object.entries(fieldOverrides)) {
        const value = String(rawValue ?? '').trim();
        if (value) crmPatch[key] = value;
      }
      if (crmPatch.firstName || crmPatch.lastName) {
        const fullName = `${crmPatch.firstName || ''} ${crmPatch.lastName || ''}`.trim();
        if (fullName) crmPatch.name = fullName;
      }
      if (!crmPatch.name?.trim()) {
        return res.status(400).json({ error: 'Vyplňte jméno a příjmení klienta.' });
      }
      markIdentificationComplete(amlCase, 'manual');
    } else {
      if (!extraction || extraction.state !== 'ready' || !extraction.proposedFields) {
        return res.status(400).json({ error: 'Nejsou dostupná žádná extrahovaná data k aplikaci.' });
      }
      if (extraction.simulated || extraction.source === 'ocr-simulated') {
        if (!inPersonVerified) {
          return res.status(400).json({
            error:
              'Tento záznam pochází ze starého simulovaného OCR. Potvrďte osobní identifikaci podle OP, nebo nahrejte fotku znovu (Vision).',
            code: 'AML_OCR_SIMULATED',
          });
        }
      }
      const source = extraction.proposedFields;
      const overrideMode =
        fieldOverrides && typeof fieldOverrides === 'object' && Object.keys(fieldOverrides).length > 0;
      const acceptedSet = new Set(Array.isArray(acceptedFields) ? acceptedFields : []);
      const keys = overrideMode ? Object.keys(fieldOverrides) : Object.keys(source);

      for (const key of keys) {
        if (!overrideMode && acceptedSet.size > 0 && !acceptedSet.has(key)) continue;
        const rawValue = overrideMode ? fieldOverrides[key] : source[key];
        const value = String(rawValue ?? '').trim();
        if (!value) continue;
        crmPatch[key] = value;
      }
      if (crmPatch.firstName || crmPatch.lastName) {
        const fullName = `${crmPatch.firstName || ''} ${crmPatch.lastName || ''}`.trim();
        if (fullName) crmPatch.name = fullName;
      }
      markIdentificationComplete(
        amlCase,
        extraction.simulated || extraction.source === 'ocr-simulated'
          ? 'upload+in_person'
          : 'upload',
      );
      amlCase.idExtraction = { ...amlCase.idExtraction, appliedAt: new Date().toISOString() };
    }

    if (crmPatch.idCard && !crmPatch.op) crmPatch.op = crmPatch.idCard;

    const finalName = crmPatch.name || clientName || amlCase.clientName;
    const screeningBirthDate = String(fieldOverrides?.birthDate || birthDate || '').trim();
    const results = await runAllRegistryChecks({
      name: finalName,
      rc: crmPatch.rc || '',
      propertyAddress,
      birthDate: screeningBirthDate,
      nationality,
    });
    mergeRegistryResults(amlCase, results);
    markScreeningComplete(amlCase);
    await persistCase(uid, amlCase);

    const appliedKeys = Object.keys(crmPatch);
    const historyNote = isManual
      ? appliedKeys.length
        ? `Ruční identifikace a screening: ${appliedKeys.join(', ')}`
        : 'Ruční identifikace — screening dokončen.'
      : appliedKeys.length
        ? `Údaje z OP (OCR) a screening: ${appliedKeys.join(', ')}`
        : 'OCR proběhlo, screening dokončen.';

    res.json({
      amlCase,
      crmPatch,
      historyNote,
      integrations: results,
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Chyba při AML apply-id-data.' });
  }
});

router.post('/client/:clientId/run-opensanctions-check', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { clientName = '', birthDate = '', nationality = 'cz' } = req.body || {};
    const uid = reqUserId(req);
    const amlCase = await getOrCreateCase(uid, clientId, clientName);

    const osResult = await runOpenSanctionsCheck({
      name: clientName || amlCase.clientName,
      birthDate,
      nationality,
    });
    const currentChecks = Array.isArray(amlCase.registryChecks) ? amlCase.registryChecks : [];
    const withoutOs = currentChecks.filter((c) => c?.name !== 'OpenSanctions - Sankce a PEP');
    amlCase.registryChecks = [
      ...withoutOs,
      {
        name: 'OpenSanctions - Sankce a PEP',
        passed: !!osResult.passed,
        detail: osResult.detail,
        source: 'opensanctions',
      },
    ];
    if (osResult.passed === false) {
      amlCase.status = 'WARNING';
      amlCase.statusMessage = 'Nalezena shoda v OpenSanctions (sankce/PEP)';
    }
    await persistCase(uid, amlCase);
    res.json({ amlCase, integrations: { opensanctions: osResult } });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Chyba při OpenSanctions kontrole.' });
  }
});

router.post('/client/:clientId/run-eu-sanctions-check', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { clientName = '' } = req.body || {};
    const uid = reqUserId(req);
    const amlCase = await getOrCreateCase(uid, clientId, clientName);

    const euResult = await runEuSanctionsCheck({ name: clientName || amlCase.clientName });
    const currentChecks = Array.isArray(amlCase.registryChecks) ? amlCase.registryChecks : [];
    const withoutEu = currentChecks.filter((c) => c?.name !== 'EU Sanctions - lokální cache');
    amlCase.registryChecks = [
      ...withoutEu,
      {
        name: 'EU Sanctions - lokální cache',
        passed: !!euResult.passed,
        detail: euResult.detail,
        source: 'eu_sanctions',
      },
    ];
    if (euResult.passed === false) {
      amlCase.status = 'WARNING';
      amlCase.statusMessage = 'Nalezena shoda v EU sanctions seznamu';
    }
    await persistCase(uid, amlCase);
    res.json({ amlCase, integrations: { euSanctions: euResult } });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Chyba při EU sanctions kontrole.' });
  }
});

router.post('/integrations/eu-sanctions/sync', (req, res) => {
  const force = Boolean(req.body?.force);
  syncEuSanctionsCache({ force })
    .then((meta) => res.json({ ok: true, ...meta }))
    .catch((error) => {
      res.status(500).json({
        ok: false,
        error: error?.message || 'Chyba při sync EU sanctions cache.',
        cache: getEuSanctionsCacheMeta(),
      });
    });
});

router.get('/integrations/eu-sanctions/meta', (req, res) => {
  res.json(getEuSanctionsCacheMeta());
});

router.post('/client/:clientId/run-ares-check', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { clientName = '', propertyAddress = '' } = req.body || {};
    const uid = reqUserId(req);
    const amlCase = await getOrCreateCase(uid, clientId, clientName);

    const aresResult = await runAresCheck(clientName || amlCase.clientName, propertyAddress);
    const currentChecks = Array.isArray(amlCase.registryChecks) ? amlCase.registryChecks : [];
    const withoutAres = currentChecks.filter((c) => c?.name !== 'ARES - Registr ekonomických subjektů');
    amlCase.registryChecks = [
      ...withoutAres,
      {
        name: 'ARES - Registr ekonomických subjektů',
        passed: !!aresResult.passed,
        detail: aresResult.detail,
        source: 'ares',
      },
    ];
    if (aresResult.passed === false) {
      amlCase.status = 'WARNING';
      amlCase.statusMessage = 'Nalezena neshoda adresy v ARES';
    }
    await persistCase(uid, amlCase);
    res.json({ amlCase, integrations: { ares: aresResult } });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Chyba při ARES kontrole.' });
  }
});

router.post('/client/:clientId/run-insolvency-check', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { clientName = '', rc = '', surname = '' } = req.body || {};
    const uid = reqUserId(req);
    const amlCase = await getOrCreateCase(uid, clientId, clientName);

    const isirResult = await runInsolvencyCheck({
      name: clientName || amlCase.clientName,
      rc,
      surname,
    });
    const currentChecks = Array.isArray(amlCase.registryChecks) ? amlCase.registryChecks : [];
    const withoutIsir = currentChecks.filter((c) => c?.name !== 'Insolvence a exekuce (ISIR)');
    amlCase.registryChecks = [
      ...withoutIsir,
      {
        name: 'Insolvence a exekuce (ISIR)',
        passed: !!isirResult.passed,
        detail: isirResult.detail,
        source: 'isir',
      },
    ];
    if (isirResult.passed === false) {
      amlCase.status = 'WARNING';
      amlCase.statusMessage = 'Nalezen záznam v ISIR (insolvence/exekuce)';
    }
    await persistCase(uid, amlCase);
    res.json({ amlCase, integrations: { insolvency: isirResult } });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Chyba při ISIR kontrole.' });
  }
});

router.post('/client/:clientId/update-status', async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const { status, statusMessage, clientName } = req.body || {};
    const uid = reqUserId(req);
    const amlCase = await getOrCreateCase(uid, clientId, clientName);

    if (status) amlCase.status = status;
    if (statusMessage) amlCase.statusMessage = statusMessage;
    await persistCase(uid, amlCase);
    res.json(amlCase);
  } catch (e) {
    next(e);
  }
});

export default router;
