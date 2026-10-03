/**
 * Sdílené vyplnění .docx přes Docxtemplater.
 */

import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { inspectDocxBuffer } from './contractTemplateValidate.js';
import { findMissingRequiredKeys } from './contractCrmMap.js';

export function fillDocxBuffer(templateBuffer, crmData, { requiredKeys = [] } = {}) {
  const inspection = inspectDocxBuffer(templateBuffer, crmData);
  const missingRequired = findMissingRequiredKeys(crmData, requiredKeys);

  if (!inspection.ok) {
    const err = new Error(
      'Šablona neprošla kontrolou — opravte neznámé tagy nebo nevyvážené závorky {{ }}.',
    );
    err.status = 400;
    err.code = 'TEMPLATE_INVALID';
    err.inspection = { ...inspection, missingRequired, emptyCrmFields: [
      ...(inspection.emptyCrmFields || []).map((f) => ({ ...f, label: f.description || f.label })),
      ...missingRequired,
    ] };
    throw err;
  }

  if (missingRequired.length) {
    const err = new Error(
      `Chybí povinná pole: ${missingRequired.map((m) => m.tag).join(', ')}. Doplňte je před stažením.`,
    );
    err.status = 400;
    err.code = 'MISSING_REQUIRED';
    err.inspection = {
      ...inspection,
      ok: false,
      missingRequired,
      emptyCrmFields: [
        ...(inspection.emptyCrmFields || []).map((f) => ({ ...f, label: f.description || f.label })),
        ...missingRequired,
      ],
    };
    throw err;
  }

  let zip;
  try {
    zip = new PizZip(templateBuffer);
  } catch {
    const err = new Error('Soubor .docx nelze načíst (poškozený archiv?).');
    err.status = 400;
    throw err;
  }

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' },
  });

  try {
    doc.render(crmData);
  } catch (e) {
    const errors = e.properties?.errors;
    const parts = errors?.length
      ? errors.map((x) => x.properties?.explanation || x.properties?.context || x.name || '').filter(Boolean)
      : [];
    const err = new Error(
      parts.length
        ? `Chyba při sestavování dokumentu: ${parts.join(' · ')}`
        : e.message || 'Chyba při vyplňování šablony.',
    );
    err.status = 400;
    err.hint =
      'Word někdy rozdělí tag do více „runů“ — přepište {{název}} ručně na jeden řádek.';
    throw err;
  }

  const out = doc.getZip().generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  return {
    buffer: Buffer.from(out),
    inspection: {
      ...inspection,
      missingRequired: [],
      emptyCrmFields: (inspection.emptyCrmFields || []).map((f) => ({
        ...f,
        label: f.description || f.label,
      })),
    },
  };
}
