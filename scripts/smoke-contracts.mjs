/**
 * Smoke: 3 šablony existují + fill DOCX (bez HTTP).
 * node scripts/smoke-contracts.mjs
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listContractTemplates,
  readTemplateDocxBuffer,
  loadManifestOverride,
} from '../src/services/contractTemplates.js';
import { buildContractRenderData } from '../src/services/contractCrmMap.js';
import { fillDocxBuffer } from '../src/services/contractDocxFill.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../assets/contracts-smoke-brokerage.docx');

const list = listContractTemplates();
assert.equal(list.length, 3);
for (const t of list) {
  assert.equal(t.fileExists, true, `${t.id} musí mít skeleton.docx`);
}

const samples = {
  brokerage: {
    clientA: {
      name: 'Petr Novák',
      email: 'petr@example.cz',
      phone: '777111222',
      address_home: 'Hlavní 1, Ostrava',
      rc: '900101/1234',
    },
    clientB: null,
    extras: {
      commission_pct: '3',
      commission_amount: '150000',
      exclusivity: 'ano',
      contract_term_months: '6',
    },
    property: 'Lískovec 537, Frýdek-Místek',
  },
  reservation: {
    clientA: {
      name: 'Jana Kupující',
      email: 'jana@example.cz',
      phone: '602111222',
      address_home: 'Nádražní 2, Ostrava',
      rc: '855101/5678',
    },
    clientB: {
      name: 'Martin Prodávající',
      email: 'martin@example.cz',
      phone: '603222333',
      address_home: 'Horní 5, Frýdek-Místek',
      rc: '750202/1111',
    },
    extras: {
      purchase_price: '4500000',
      reservation_deposit: '100000',
      reservation_deadline: '30. 6. 2026',
    },
    property: 'Byt 3+kk, Ostrava-Poruba',
  },
  lease: {
    clientA: {
      name: 'Eva Pronajímatelová',
      email: 'eva@example.cz',
      phone: '604333444',
      address_home: 'Slezská 8, Opava',
      rc: '705505/9999',
    },
    clientB: {
      name: 'Tomáš Nájemce',
      email: 'tomas@example.cz',
      phone: '605444555',
      address_home: 'Krátká 3, Opava',
      rc: '920303/2222',
    },
    extras: {
      rent_monthly: '14500',
      deposit_amount: '29000',
      lease_start: '1. 7. 2026',
      lease_end: '30. 6. 2027',
      payment_day: '5',
      property_disposition: '2+kk',
      property_area_m2: '52',
    },
    property: 'Byt 2+kk, Opava',
  },
};

const agency = {
  name: 'Makio Reality',
  ico: '12345678',
  brokerName: 'Michal Ohanka',
  brokerEmail: 'michal@makio.cz',
  brokerPhone: '777000111',
};

for (const id of Object.keys(samples)) {
  const meta = loadManifestOverride(id);
  const { buffer } = readTemplateDocxBuffer(id);
  const s = samples[id];
  const data = buildContractRenderData({
    contractType: id,
    templateId: id,
    templateVersion: meta.version,
    clientA: s.clientA,
    clientB: s.clientB || undefined,
    agency,
    propertyAddress: s.property,
    extras: s.extras,
  });
  const { buffer: out, inspection } = fillDocxBuffer(buffer, data, {
    requiredKeys: meta.requiredKeys,
  });
  assert.equal(inspection.ok, true, `${id}: inspection.ok`);
  assert.ok(out.length > 800, `${id}: výstup DOCX`);
  console.log('OK fill', id, `(${out.length} B)`);
  if (id === 'brokerage') writeFileSync(OUT, out);
}

console.log('contracts smoke OK →', OUT);
