import { Router } from 'express';
import multer from 'multer';
import {
  buildFullContractRenderData,
  buildContractRenderData,
  listContractTagDocumentation,
  findMissingRequiredKeys,
} from '../services/contractCrmMap.js';
import { inspectDocxBuffer } from '../services/contractTemplateValidate.js';
import { buildContractPdfBuffer } from '../services/contractPdf.js';
import { contractRouteLimiter } from '../middleware/rateLimits.js';
import {
  listContractTemplates,
  getContractTemplate,
  readTemplateDocxBuffer,
  loadManifestOverride,
} from '../services/contractTemplates.js';
import { fillDocxBuffer } from '../services/contractDocxFill.js';
import { convertDocxToPdf, isLibreOfficeAvailable, resolveSofficeBinary } from '../services/contractLibreOffice.js';
import { storeContractGeneration } from '../services/contractGenerations.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (!name.endsWith('.docx')) {
      cb(
        new Error(
          'Je nutný soubor .docx (Word). Do šablony vložte tagy {{client_name}}, {{property_address}} atd.',
        ),
      );
      return;
    }
    cb(null, true);
  },
});

function runUpload(req, res, next) {
  upload.single('template')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || String(err) });
    next();
  });
}

function isDocxZipBuffer(buf) {
  return buf && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function parsePayload(req) {
  try {
    return JSON.parse(req.body.payload || '{}');
  } catch {
    return null;
  }
}

function withLabels(inspection) {
  if (!inspection) return inspection;
  const emptyCrmFields = (inspection.emptyCrmFields || []).map((f) => ({
    ...f,
    label: f.label || f.description || f.tag,
  }));
  return { ...inspection, emptyCrmFields };
}

function parseLibraryBody(req) {
  const body = req.body || {};
  const templateId = String(body.templateId || body.template_id || '').toLowerCase();
  const clientA = body.clientA || body.client || {};
  const clientB = body.clientB || null;
  const agency = body.agency || {};
  const extras = body.extras && typeof body.extras === 'object' ? body.extras : {};
  const property =
    body.property != null
      ? String(body.property)
      : extras.property_address != null
        ? String(extras.property_address)
        : '';
  return { templateId, clientA, clientB, agency, extras, property };
}

function buildDataFromLibraryBody(parsed, meta) {
  return buildContractRenderData({
    clientA: parsed.clientA,
    clientB: parsed.clientB || undefined,
    agency: parsed.agency,
    extras: parsed.extras,
    propertyAddress: parsed.property,
    templateId: meta?.id,
    templateVersion: meta?.version,
    contractType: meta?.id,
  });
}

/** Seznam podporovaných CRM tagů */
router.get('/crm-tags', (req, res) => {
  res.json({ tags: listContractTagDocumentation() });
});

/** Knihovna šablon vlny 1 */
router.get('/templates', (req, res) => {
  res.json({
    templates: listContractTemplates(),
    libreOffice: {
      availableHint: isLibreOfficeAvailable(),
      path: resolveSofficeBinary(),
    },
  });
});

router.get('/templates/:id', (req, res) => {
  const meta = loadManifestOverride(req.params.id) || getContractTemplate(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Neznámá šablona.' });
  const listed = getContractTemplate(meta.id);
  res.json({ template: { ...meta, fileExists: listed?.fileExists, path: listed?.path } });
});

/**
 * POST /api/contracts/inspect-library
 * JSON: { templateId, clientA, clientB?, agency?, extras?, property? }
 */
router.post('/inspect-library', contractRouteLimiter, (req, res) => {
  try {
    const parsed = parseLibraryBody(req);
    const meta = loadManifestOverride(parsed.templateId) || getContractTemplate(parsed.templateId);
    if (!meta) return res.status(404).json({ error: 'Neznámá šablona.' });
    const { buffer } = readTemplateDocxBuffer(meta.id);
    const crmData = buildDataFromLibraryBody(parsed, meta);
    const inspection = withLabels(inspectDocxBuffer(buffer, crmData));
    const missingRequired = findMissingRequiredKeys(crmData, meta.requiredKeys || []);
    res.json({
      ...inspection,
      missingRequired,
      emptyCrmFields: [
        ...(inspection.emptyCrmFields || []),
        ...missingRequired.filter((m) => !(inspection.emptyCrmFields || []).some((e) => e.tag === m.tag)),
      ],
      canFill: inspection.ok && missingRequired.length === 0,
      template: { id: meta.id, title: meta.title, version: meta.version },
    });
  } catch (e) {
    console.error('[contracts/inspect-library]', e);
    res.status(e.status || 500).json({ error: e.message || 'Kontrola se nezdařila.', code: e.code });
  }
});

/**
 * POST /api/contracts/fill-from-library → filled .docx
 */
router.post('/fill-from-library', contractRouteLimiter, async (req, res) => {
  try {
    const parsed = parseLibraryBody(req);
    const meta = loadManifestOverride(parsed.templateId) || getContractTemplate(parsed.templateId);
    if (!meta) return res.status(404).json({ error: 'Neznámá šablona.' });
    const { buffer } = readTemplateDocxBuffer(meta.id);
    const crmData = buildDataFromLibraryBody(parsed, meta);
    const { buffer: out } = fillDocxBuffer(buffer, crmData, { requiredKeys: meta.requiredKeys || [] });

    await storeContractGeneration({
      userId: req.user?.id || null,
      templateId: meta.id,
      templateVersion: meta.version,
      clientAId: parsed.clientA?.id || null,
      clientBId: parsed.clientB?.id || null,
      crmData,
      outputFormat: 'docx',
    });

    const filename = `${meta.id}_vyplneno_${crmData.date_iso}.docx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(out);
  } catch (e) {
    console.error('[contracts/fill-from-library]', e);
    res.status(e.status || 500).json({
      error: e.message || 'Vyplnění se nezdařilo.',
      code: e.code,
      hint: e.hint,
      inspection: e.inspection ? withLabels(e.inspection) : undefined,
    });
  }
});

/**
 * POST /api/contracts/fill-from-library-pdf → PDF ze vyplněného DOCX (LibreOffice)
 */
router.post('/fill-from-library-pdf', contractRouteLimiter, async (req, res) => {
  try {
    const parsed = parseLibraryBody(req);
    const meta = loadManifestOverride(parsed.templateId) || getContractTemplate(parsed.templateId);
    if (!meta) return res.status(404).json({ error: 'Neznámá šablona.' });
    const { buffer } = readTemplateDocxBuffer(meta.id);
    const crmData = buildDataFromLibraryBody(parsed, meta);
    const { buffer: docx } = fillDocxBuffer(buffer, crmData, { requiredKeys: meta.requiredKeys || [] });
    const pdf = await convertDocxToPdf(docx);

    await storeContractGeneration({
      userId: req.user?.id || null,
      templateId: meta.id,
      templateVersion: meta.version,
      clientAId: parsed.clientA?.id || null,
      clientBId: parsed.clientB?.id || null,
      crmData,
      outputFormat: 'pdf',
    });

    const filename = `${meta.id}_vyplneno_${crmData.date_iso}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(pdf);
  } catch (e) {
    console.error('[contracts/fill-from-library-pdf]', e);
    res.status(e.status || 500).json({
      error: e.message || 'PDF se nepodařilo vytvořit.',
      code: e.code,
      inspection: e.inspection ? withLabels(e.inspection) : undefined,
    });
  }
});

/**
 * POST /api/contracts/inspect — custom upload
 */
router.post('/inspect', contractRouteLimiter, runUpload, (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer?.length) {
      return res.status(400).json({ error: 'Chybí soubor šablony (pole template, .docx).' });
    }
    if (!isDocxZipBuffer(file.buffer)) {
      return res.status(400).json({ error: 'Soubor není platný dokument Word (.docx = ZIP).' });
    }
    const payload = parsePayload(req);
    if (payload === null) {
      return res.status(400).json({ error: 'Neplatný JSON v poli payload.' });
    }
    const client = payload.client && typeof payload.client === 'object' ? payload.client : {};
    const property = payload.property != null ? String(payload.property) : '';
    const crmData = buildFullContractRenderData(client, property);
    res.json(withLabels(inspectDocxBuffer(file.buffer, crmData)));
  } catch (e) {
    console.error('[contracts/inspect]', e);
    res.status(500).json({ error: e.message || 'Kontrola se nezdařila.' });
  }
});

/**
 * POST /api/contracts/fill — custom upload
 */
router.post('/fill', contractRouteLimiter, runUpload, async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer?.length) {
      return res.status(400).json({ error: 'Chybí soubor šablony (pole template, .docx).' });
    }
    if (!isDocxZipBuffer(file.buffer)) {
      return res.status(400).json({ error: 'Soubor není platný dokument Word (.docx = ZIP).' });
    }

    const payload = parsePayload(req);
    if (payload === null) {
      return res.status(400).json({ error: 'Neplatný JSON v poli payload.' });
    }

    const client = payload.client && typeof payload.client === 'object' ? payload.client : {};
    const property = payload.property != null ? String(payload.property) : '';
    const data = buildFullContractRenderData(client, property);

    const { buffer: out } = fillDocxBuffer(file.buffer, data, { requiredKeys: [] });

    const baseName = (file.originalname || 'smlouva').replace(/\.docx$/i, '');
    const safeBase = baseName.replace(/[^\w\u00C0-\u024F\s\-_.]+/g, '_').trim() || 'smlouva';
    const filename = `${safeBase}_vyplneno_${data.date_iso}.docx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(out);
  } catch (e) {
    console.error('[contracts/fill]', e);
    res.status(e.status || 500).json({
      error: e.message || 'Vyplnění se nezdařilo.',
      code: e.code,
      hint: e.hint,
      inspection: e.inspection ? withLabels(e.inspection) : undefined,
    });
  }
});

/**
 * POST /api/contracts/fill-pdf — kontrolní list CRM
 */
router.post('/fill-pdf', contractRouteLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    let data;
    if (body.templateId || body.clientA) {
      const parsed = parseLibraryBody(req);
      const meta = parsed.templateId
        ? loadManifestOverride(parsed.templateId) || getContractTemplate(parsed.templateId)
        : { id: '', version: '', title: '' };
      data = buildDataFromLibraryBody(parsed, meta || {});
    } else {
      const client = body.client && typeof body.client === 'object' ? body.client : {};
      const property = body.property != null ? String(body.property) : '';
      if (!client.name && !client.firstName && !client.lastName) {
        return res.status(400).json({ error: 'Chybí klient (client.name).' });
      }
      data = buildFullContractRenderData(client, property);
    }
    const pdf = await buildContractPdfBuffer(data);
    const safeName = String(data.client_name || data.party_a_name || 'kontrolni-list')
      .replace(/[^\w\u00C0-\u024F\s\-_.]+/g, '_')
      .trim()
      .slice(0, 40) || 'kontrolni-list';
    const filename = `${safeName}_kontrolni-list_${data.date_iso || 'navrh'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(pdf);
  } catch (e) {
    console.error('[contracts/fill-pdf]', e);
    res.status(500).json({ error: e.message || 'PDF se nepodařilo vytvořit.' });
  }
});

router.post('/generate', (req, res) => {
  res.status(410).json({
    error: 'Použijte POST /api/contracts/fill-from-library, /fill, /fill-pdf nebo /inspect.',
  });
});

export default router;
