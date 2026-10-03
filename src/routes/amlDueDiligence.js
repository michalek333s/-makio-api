/**
 * AML & Právní Due Diligence — produkční endpointy
 * (ekvivalent Next.js App Router: verify-isir / verify-ares / create-check)
 */

import { Router } from 'express';
import { verifyIsir, isIsirConfigured } from '../services/inshlidacIsir.js';
import { verifyAresByIco, searchAresByName } from '../services/aresLookup.js';
import {
  screenOpenSanctions,
  isOpenSanctionsConfigured,
} from '../services/openSanctionsScreening.js';
import {
  createAmlCheck,
  listAmlChecks,
  getAmlCheckById,
  getAmlChecksSummary,
  computeRiskAndStatus,
  isAmlChecksConfigured,
} from '../services/amlChecksStore.js';
import { buildAmlProtocolPdf } from '../services/amlProtocolPdf.js';
import { extractIdDocumentFields, isIdOcrConfigured } from '../services/idDocumentOcr.js';

const router = Router();

function reqUserId(req) {
  return req.user?.id || req.authUser?.id || null;
}

function brokerMeta(req) {
  const u = req.user || req.authUser || {};
  const meta = u.user_metadata || {};
  return {
    broker_name:
      String(req.body?.broker_name || u.full_name || meta.full_name || '').trim() || null,
    agency_name:
      String(
        req.body?.agency_name || u.agency || u.business_name || meta.agency || meta.business_name || '',
      ).trim() || null,
    agency_ico: String(req.body?.agency_ico || u.ico || meta.ico || '').replace(/\s/g, '').trim() || null,
  };
}

/** POST /api/aml/verify-isir  { identifier, type: 'rc'|'ic' } */
router.post('/verify-isir', async (req, res) => {
  try {
    const identifier = String(req.body?.identifier || '').trim();
    const type = String(req.body?.type || '').trim().toLowerCase();
    if (!identifier || !['rc', 'ic'].includes(type)) {
      return res.status(400).json({
        error: "Očekáváno { identifier: string, type: 'rc' | 'ic' }",
        code: 'VALIDATION',
      });
    }

    const result = await verifyIsir({ identifier, type });
    return res.json({
      hasRecord: result.hasRecord,
      cases: result.cases || [],
      isirStatus: result.isirStatus,
      error: result.error || null,
      checkedAt: result.checkedAt,
      dataSource: result.dataSource,
      configured: isIsirConfigured(),
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      error: error?.message || 'ISIR lustrace selhala',
      code: error?.code || 'ISIR_ERROR',
    });
  }
});

/** GET /api/aml/verify-ares?ico=12345678 */
router.get('/verify-ares', async (req, res) => {
  try {
    const ico = String(req.query?.ico || '').trim();
    const data = await verifyAresByIco(ico);
    return res.json(data);
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      error: error?.message || 'ARES lustrace selhala',
      code: error?.code || 'ARES_ERROR',
    });
  }
});

/** GET /api/aml/search-ares?q=ABC+Reality — našeptávač podle názvu */
router.get('/search-ares', async (req, res) => {
  try {
    const q = String(req.query?.q || req.query?.obchodniJmeno || '').trim();
    const data = await searchAresByName(q, { limit: Number(req.query?.limit) || 8 });
    return res.json(data);
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      error: error?.message || 'ARES hledání selhalo',
      code: error?.code || 'ARES_SEARCH_ERROR',
    });
  }
});

/**
 * POST /api/aml/extract-id
 * Jednorázové OCR OP/pasu. Fotka se neukládá — jen textové údaje.
 * Body: { imageBase64, mimeType }
 */
router.post('/extract-id', async (req, res) => {
  try {
    if (!isIdOcrConfigured()) {
      return res.status(503).json({
        error: 'OCR dokladu není nastavené (OPENAI_API_KEY). Použijte ruční vyplnění.',
        code: 'OCR_NOT_CONFIGURED',
        configured: false,
      });
    }
    const result = await extractIdDocumentFields({
      imageBase64: req.body?.imageBase64 || req.body?.image,
      mimeType: req.body?.mimeType || req.body?.mime_type || 'image/jpeg',
    });
    if (!result.usable) {
      return res.status(422).json({
        error: 'Z fotky se nepodařilo přečíst údaje. Zkuste ostřejší foto přední strany OP, nebo vyplňte ručně.',
        code: 'OCR_EMPTY',
        ...result,
      });
    }
    res.json({ ...result, configured: true });
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      error: error?.message || 'OCR dokladu selhalo',
      code: error?.code || 'OCR_ERROR',
      configured: isIdOcrConfigured(),
    });
  }
});

/** POST /api/aml/verify-sanctions — OpenSanctions PEP + sankce */
router.post('/verify-sanctions', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await screenOpenSanctions({
      name: body.name || body.full_name,
      birthDate: body.birth_date || body.birthDate,
      nationality: body.nationality || 'cz',
      clientType: body.client_type || body.clientType || 'natural_person',
    });
    res.json({ ...result, configured: isOpenSanctionsConfigured() });
  } catch (error) {
    res.status(500).json({
      error: error?.message || 'OpenSanctions screening selhal',
      code: 'SANCTIONS_ERROR',
    });
  }
});

/** POST /api/aml/create-check — uloží auditní záznam + risk_score */
router.post('/create-check', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId && process.env.AUTH_ALLOW_ANON_DEV !== '1') {
      return res.status(401).json({ error: 'Přihlášení vyžadováno', code: 'AUTH_REQUIRED' });
    }

    const body = req.body || {};
    const meta = brokerMeta(req);
    const autoScreen = body.auto_screen !== false;

    // ISIR
    let isir_status = body.isir_status;
    let isir_details = body.isir_details || null;
    if (autoScreen && !isir_status && body.identifier) {
      const type = body.client_type === 'legal_entity' ? 'ic' : 'rc';
      const isir = await verifyIsir({ identifier: body.identifier, type });
      isir_status = isir.isirStatus;
      isir_details = { hasRecord: isir.hasRecord, cases: isir.cases, error: isir.error || null };
    }

    // OpenSanctions — PEP + sankce automaticky (ne checkbox)
    let opensanctions_details = body.opensanctions_details || null;
    let is_pep = Boolean(body.is_pep);
    let is_sanctioned = Boolean(body.is_sanctioned);

    if (autoScreen && body.full_name && !opensanctions_details) {
      const os = await screenOpenSanctions({
        name: body.full_name,
        birthDate: body.birth_date,
        nationality: body.nationality || 'cz',
        clientType: body.client_type || 'natural_person',
      });
      opensanctions_details = os;
      // Automatický verdikt z API; manuální true z body může jen zpřísnit
      is_pep = is_pep || Boolean(os.isPep);
      is_sanctioned = is_sanctioned || Boolean(os.isSanctioned);
    }

    const isirResolved = isir_status || 'clean';
    const screening_incomplete =
      isirResolved === 'error' ||
      opensanctions_details?.classification === 'incomplete';

    const preview = computeRiskAndStatus({
      is_pep,
      is_sanctioned,
      isir_status: isirResolved,
      screening_incomplete,
    });

    const check = await createAmlCheck(userId || 'anon-dev', {
      client_type: body.client_type,
      full_name: body.full_name,
      identifier: body.identifier,
      birth_date: body.birth_date || null,
      address: body.address || null,
      nationality: body.nationality || null,
      id_document: body.id_document || null,
      in_person_verified: Boolean(body.in_person_verified),
      representative_name: body.representative_name || null,
      representative_id_doc: body.representative_id_doc || null,
      representative_birth_date: body.representative_birth_date || null,
      beneficial_owner: body.beneficial_owner || null,
      transaction_type: body.transaction_type || null,
      property_address: body.property_address || null,
      funds_source: body.funds_source || null,
      is_pep,
      is_sanctioned,
      isir_status: isirResolved,
      isir_details,
      ares_data: body.ares_data || null,
      note: body.note || null,
      broker_name: meta.broker_name,
      agency_name: meta.agency_name,
      opensanctions_details,
      screening_incomplete,
    });

    res.status(201).json({
      check,
      risk_score: check.risk_score || preview.risk_score,
      check_status: check.check_status || preview.check_status,
      screening: {
        isir: isir_details,
        opensanctions: opensanctions_details,
        is_pep,
        is_sanctioned,
      },
      persistConfigured: isAmlChecksConfigured(),
      persistWarning: check._persistError || check._persistWarning || null,
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({
      error: error?.message || 'Uložení AML kontroly selhalo',
      code: error?.code || 'CREATE_CHECK_ERROR',
    });
  }
});

/** GET /api/aml/checks — historie */
router.get('/checks', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(401).json({ error: 'Přihlášení vyžadováno', code: 'AUTH_REQUIRED' });
    const [checks, summary] = await Promise.all([
      listAmlChecks(userId, { limit: Number(req.query?.limit) || 50 }),
      getAmlChecksSummary(userId),
    ]);
    res.json({ checks, summary, persistConfigured: isAmlChecksConfigured() });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Načtení historie selhalo' });
  }
});

function sendProtocolPdf(res, check, req = null) {
  const fromAuth = req ? brokerMeta(req) : {};
  return buildAmlProtocolPdf(check, {
    brokerName: check.broker_name || fromAuth.broker_name || req?.body?.broker_name,
    agencyName: check.agency_name || fromAuth.agency_name || req?.body?.agency_name,
    agencyIco: check.agency_ico || fromAuth.agency_ico || req?.body?.agency_ico,
    fullName: fromAuth.broker_name,
  }).then((buf) => {
    const safeName = String(check.full_name || 'klient')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 40);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="AML_protokol_${safeName}_${String(check.id || 'draft').slice(0, 8)}.pdf"`,
    );
    res.send(buf);
  });
}

/** POST /api/aml/protocol-preview.pdf — PDF i bez uložení do cloudu */
router.post('/protocol-preview.pdf', async (req, res) => {
  try {
    const check = req.body?.check || req.body || {};
    if (!check.full_name || !check.identifier) {
      return res.status(400).json({ error: 'Chybí údaje kontroly pro PDF' });
    }
    await sendProtocolPdf(res, check, req);
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Generování PDF selhalo' });
  }
});

/** GET /api/aml/checks/:id/protocol.pdf */
router.get('/checks/:id/protocol.pdf', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(401).json({ error: 'Přihlášení vyžadováno', code: 'AUTH_REQUIRED' });

    const check = await getAmlCheckById(userId, req.params.id);
    if (!check) return res.status(404).json({ error: 'Kontrola nenalezena' });
    await sendProtocolPdf(res, check, req);
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Generování PDF selhalo' });
  }
});

/** GET /api/aml/checks/export.csv — auditní log */
router.get('/checks/export.csv', async (req, res) => {
  try {
    const userId = reqUserId(req);
    if (!userId) return res.status(401).json({ error: 'Přihlášení vyžadováno', code: 'AUTH_REQUIRED' });
    const checks = await listAmlChecks(userId, { limit: 500 });
    const header = [
      'id',
      'created_at',
      'full_name',
      'client_type',
      'identifier',
      'is_pep',
      'is_sanctioned',
      'isir_status',
      'risk_score',
      'check_status',
      'broker_name',
    ];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [header.join(',')];
    for (const c of checks) {
      lines.push(header.map((h) => esc(c[h])).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="aml_audit_log.csv"');
    res.send('\uFEFF' + lines.join('\n'));
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Export selhal' });
  }
});

export default router;
