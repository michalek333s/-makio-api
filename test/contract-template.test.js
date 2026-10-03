import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinWTextContent,
  extractVariableTagsFromJoinedText,
  suggestClosestKey,
} from '../src/services/contractTemplateValidate.js';
import { buildFullContractRenderData, CONTRACT_CRM_KEYS } from '../src/services/contractCrmMap.js';

test('joinWTextContent spojí rozdělené Word runy u tagu', () => {
  const xml = `<w:p>
    <w:r><w:t>{{</w:t></w:r>
    <w:r><w:t>client_name</w:t></w:r>
    <w:r><w:t>}}</w:t></w:r>
  </w:p>`;
  const joined = joinWTextContent(xml);
  assert.equal(joined, '{{client_name}}');
  const tags = extractVariableTagsFromJoinedText(joined);
  assert.deepEqual(tags, ['client_name']);
});

test('extractVariableTags ignoruje docxtemplater řídicí tagy', () => {
  const s = '{{#list}} {{client_email}} {{/list}} {{ x | filter }}';
  const tags = extractVariableTagsFromJoinedText(s);
  assert.equal(tags.includes('client_email'), true);
  assert.equal(tags.includes('#list'), false);
});

test('suggestClosestKey navrhne překlep', () => {
  assert.equal(suggestClosestKey('client_nam'), 'client_name');
  assert.equal(suggestClosestKey('totally_unknown_xyz'), null);
});

test('buildFullContractRenderData má všechny klíče a pouze stringy', () => {
  const d = buildFullContractRenderData({ name: 'Jan Novák', email: '' }, 'Praha');
  for (const k of CONTRACT_CRM_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(d, k));
    assert.equal(typeof d[k], 'string');
  }
  assert.equal(d.client_name, 'Jan Novák');
  assert.equal(d.property_address, 'Praha');
});
