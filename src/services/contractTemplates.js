/**
 * Knihovna smluvních šablon: brokerage, reservation, lease, purchase.
 * Ostré .docx = advokátní PDF → template.docx s {{tagy}} (bez AI právního textu).
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS_TEMPLATES_ROOT = join(__dirname, '../../templates/contracts');

function loadManifestFromFolder(folder) {
  try {
    const p = join(CONTRACTS_TEMPLATES_ROOT, folder, 'manifest.json');
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/** @param {string} templateId */
export function loadManifestOverride(templateId) {
  const def = CONTRACT_TEMPLATE_DEFS[String(templateId || '').toLowerCase()];
  if (!def) return null;
  const man = loadManifestFromFolder(def.folder);
  return { ...def, ...man, id: def.id };
}

/** @type {Record<string, object>} */
export const CONTRACT_TEMPLATE_DEFS = {
  brokerage: {
    id: 'brokerage',
    title: 'Smlouva o zprostředkování',
    version: 'v1.0.0',
    folder: 'brokerage/v1',
    lawyer: null,
    approvedAt: null,
    requiredKeys: [
      'party_a_name',
      'agency_name',
      'broker_name',
      'property_address',
      'commission_pct',
      'date_today_cs',
    ],
    roleHints: {
      partyA: 'Klient (prodávající / majitel)',
      partyB: null,
    },
  },
  reservation: {
    id: 'reservation',
    title: 'Rezervační smlouva',
    version: 'v1.1.0-lawyer',
    folder: 'reservation/v1',
    lawyer: null,
    approvedAt: null,
    requiredKeys: [
      'kupujici_name',
      'prodavajici_name',
      'property_lv',
      'purchase_price',
      'reservation_deposit',
      'reservation_deadline',
      'date_today_cs',
    ],
    roleHints: {
      partyA: 'Zájemce / kupující',
      partyB: 'Prodávající',
    },
  },
  lease: {
    id: 'lease',
    title: 'Nájemní smlouva',
    version: 'v1.1.0-lawyer',
    folder: 'lease/v1',
    lawyer: null,
    approvedAt: null,
    requiredKeys: [
      'pronajimatel_name',
      'najemce_name',
      'property_unit',
      'rent_monthly',
      'deposit_amount',
      'lease_start',
      'date_today_cs',
    ],
    roleHints: {
      partyA: 'Pronajímatel',
      partyB: 'Nájemce',
    },
  },
  purchase: {
    id: 'purchase',
    title: 'Kupní smlouva',
    version: 'v1.0.0-lawyer',
    folder: 'purchase/v1',
    lawyer: null,
    approvedAt: null,
    requiredKeys: [
      'prodavajici_name',
      'kupujici_name',
      'property_lv',
      'purchase_price',
      'date_today_cs',
    ],
    roleHints: {
      partyA: 'Prodávající',
      partyB: 'Kupující',
    },
  },
};

export function listContractTemplates() {
  return Object.values(CONTRACT_TEMPLATE_DEFS).map((def) => {
    const path = resolveTemplateDocxPath(def.id);
    const man = loadManifestFromFolder(def.folder);
    const merged = { ...def, ...man, id: def.id };
    const approvedAt = merged.approvedAt || null;
    return {
      ...merged,
      fileExists: Boolean(path),
      path: path || null,
      isSkeleton: path ? String(path).includes('skeleton') || !approvedAt : true,
      hasOriginalPdf: existsSync(join(CONTRACTS_TEMPLATES_ROOT, def.folder, 'original.pdf')),
    };
  });
}

export function getContractTemplate(id) {
  const def = CONTRACT_TEMPLATE_DEFS[String(id || '').toLowerCase()];
  if (!def) return null;
  const path = resolveTemplateDocxPath(def.id);
  const man = loadManifestFromFolder(def.folder);
  const merged = { ...def, ...man, id: def.id };
  const approvedAt = merged.approvedAt || null;
  return {
    ...merged,
    fileExists: Boolean(path),
    path: path || null,
    isSkeleton: path ? String(path).includes('skeleton') || !approvedAt : true,
    hasOriginalPdf: existsSync(join(CONTRACTS_TEMPLATES_ROOT, def.folder, 'original.pdf')),
  };
}

export function resolveTemplateDocxPath(templateId) {
  const def = CONTRACT_TEMPLATE_DEFS[String(templateId || '').toLowerCase()];
  if (!def) return null;
  const dir = join(CONTRACTS_TEMPLATES_ROOT, def.folder);
  const preferred = join(dir, 'template.docx');
  if (existsSync(preferred)) return preferred;
  const skeleton = join(dir, 'skeleton.docx');
  if (existsSync(skeleton)) return skeleton;
  try {
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.docx'));
    if (files[0]) return join(dir, files[0]);
  } catch {
    /* missing dir */
  }
  return null;
}

export function readTemplateDocxBuffer(templateId) {
  const path = resolveTemplateDocxPath(templateId);
  if (!path) {
    const err = new Error(`Šablona „${templateId}“ nemá .docx soubor.`);
    err.status = 404;
    throw err;
  }
  return { buffer: readFileSync(path), path };
}
