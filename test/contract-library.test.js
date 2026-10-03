/**
 * Integrační smoke: skeleton fill DOCX pro brokerage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTemplateDocxBuffer, listContractTemplates } from '../src/services/contractTemplates.js';
import { buildContractRenderData } from '../src/services/contractCrmMap.js';
import { fillDocxBuffer } from '../src/services/contractDocxFill.js';
import { loadManifestOverride } from '../src/services/contractTemplates.js';

test('listContractTemplates má 3 typy', () => {
  const list = listContractTemplates();
  assert.equal(list.length, 3);
  assert.ok(list.every((t) => t.fileExists), 'skeletony musí existovat (npm run contracts:skeletons)');
});

test('fill brokerage skeleton s povinnými poli', () => {
  const meta = loadManifestOverride('brokerage');
  const { buffer } = readTemplateDocxBuffer('brokerage');
  const data = buildContractRenderData({
    contractType: 'brokerage',
    templateId: 'brokerage',
    templateVersion: meta.version,
    clientA: {
      name: 'Petr Novák',
      email: 'petr@example.cz',
      phone: '777111222',
      address_home: 'Hlavní 1, Ostrava',
      rc: '900101/1234',
    },
    agency: {
      name: 'Makio Reality',
      ico: '12345678',
      brokerName: 'Jana Makléřová',
      brokerEmail: 'jana@makio.cz',
      brokerPhone: '602000111',
    },
    propertyAddress: 'Lískovec 537, Frýdek-Místek',
    extras: {
      commission_pct: '3',
      commission_amount: '150000',
      exclusivity: 'ano',
      contract_term_months: '6',
      property_lv: '123',
      property_parcel: '4673/31',
      property_area_m2: '85',
    },
  });
  const { buffer: out, inspection } = fillDocxBuffer(buffer, data, {
    requiredKeys: meta.requiredKeys,
  });
  assert.ok(out.length > 1000);
  assert.equal(inspection.ok, true);
  assert.ok(out[0] === 0x50 && out[1] === 0x4b, 'výstup je ZIP/docx');
});
