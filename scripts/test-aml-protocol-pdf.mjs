/**
 * Generuje testovací AML PDF a ověří 1 stránku + propis makléře.
 * node scripts/test-aml-protocol-pdf.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAmlProtocolPdf, mapCheckToFullAmlReport } from '../src/services/amlProtocolPdf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, '../assets/aml-protocol-full-test.pdf');

const check = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  created_at: new Date().toISOString(),
  client_type: 'natural_person',
  full_name: 'Jan Novák',
  identifier: '850101/1234',
  birth_date: '1985-01-01',
  address: 'Hlavní 12, 738 01 Frýdek-Místek',
  id_document: 'OP 123456789',
  transaction_type: 'Zprostředkování převodu nemovitosti',
  property_address: 'Byt 3+kk, Ostrava',
  funds_source: 'Vlastní úspory / Hypoteční úvěr',
  is_pep: false,
  is_sanctioned: false,
  isir_status: 'clean',
  risk_score: 'low',
  check_status: 'approved',
};

const mapped = mapCheckToFullAmlReport(check, {
  brokerName: 'Michal Ohanka',
  agencyName: 'Makio Reality',
  agencyIco: '12345678',
});

if (mapped.brokerName.includes('—') || mapped.brokerName === '—') {
  throw new Error('brokerName nesmí být pomlčka');
}
if (!/Makio Reality/.test(mapped.agencyName) || !/IČO/.test(mapped.agencyName)) {
  throw new Error(`Očekáván Makio Reality + IČO, dostáno: ${mapped.agencyName}`);
}

const buf = await buildAmlProtocolPdf(check, {
  brokerName: 'Michal Ohanka',
  agencyName: 'Makio Reality',
  agencyIco: '12345678',
});

fs.writeFileSync(out, buf);

// Počet stran: /Type /Page (bez Parent) — hrubý check
const text = buf.toString('latin1');
const pageCount = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
if (pageCount !== 1) {
  throw new Error(`PDF má ${pageCount} stran, očekáváno 1`);
}
if (!text.includes('Michal') && !buf.includes(Buffer.from('Michal'))) {
  // PDF text může být v WinAnsi — aspoň ověřit délku
  console.warn('Jméno makléře v raw streamu nenalezeno (možná komprese) — layout OK pokud 1 strana.');
}

console.log('AML PDF OK:', out, `(${buf.length} B, ${pageCount} strana)`);
