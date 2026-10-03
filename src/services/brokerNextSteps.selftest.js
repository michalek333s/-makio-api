import assert from 'node:assert/strict';
import {
  enrichBrokerNextSteps,
  filterAndCapNextSteps,
  resolveFocusClientName,
  extractNameFromStepLabel,
  MAX_CHAT_NEXT_STEPS,
} from './brokerNextSteps.js';

assert.equal(MAX_CHAT_NEXT_STEPS, 2);
assert.equal(extractNameFromStepLabel('Doplň kontakt — Barbora Nováková'), 'Barbora Nováková');

assert.equal(
  resolveFocusClientName({
    parsed: { targetClientName: 'Petr Horák' },
    message: 'ahoj',
    activeClientName: 'Barbora Nováková',
  }),
  'Petr Horák',
);

assert.equal(
  resolveFocusClientName({
    parsed: {},
    message: 'co dál s hypotékou',
    activeClientName: 'Barbora Nováková',
  }),
  '',
);

const filtered = filterAndCapNextSteps(
  [
    { label: 'Doplň kontakt — Barbora Nováková', actionType: 'CLIENT', suggestedMessage: 'Barbora Nováková' },
    { label: 'SMS — Petr Horák', actionType: 'MESSAGE', suggestedMessage: 'Petr Horák' },
    { label: 'Radar', actionType: 'RADAR', suggestedMessage: 'Ostrava' },
  ],
  { focusClientName: 'Petr Horák', message: 'co s Petrem Horákem' },
);
assert.equal(filtered.length, 2);
assert.ok(filtered.every((s) => !/Barbora/i.test(s.label)));

const expert = enrichBrokerNextSteps(
  { intent: 'general_chat', chatResponse: 'DSTI 40 %', nextSteps: [] },
  { message: 'co je DSTI?', activeClientName: 'Barbora Nováková' },
);
assert.equal((expert.nextSteps || []).length, 0, 'odborná rada bez operativní akce = 0 tlačítek');

const crm = enrichBrokerNextSteps(
  {
    intent: 'crm_action',
    isNewClient: true,
    targetClientName: 'Petr Horák',
    nextSteps: [
      { label: 'Doplň kontakt — Barbora Nováková', actionType: 'CLIENT', suggestedMessage: 'Barbora Nováková' },
      { label: 'Radar', actionType: 'RADAR' },
      { label: 'Kalkulačka', actionType: 'CALCULATOR' },
    ],
  },
  { message: 'přidej klienta Petr Horák', activeClientName: 'Barbora Nováková' },
);
  assert.ok((crm.nextSteps || []).length <= 2);
assert.ok(crm.nextSteps.every((s) => !/Barbora/i.test(s.label)));
assert.ok(crm.nextSteps.some((s) => /Petr|kontakt/i.test(s.label)));

const padded = enrichBrokerNextSteps(
  {
    intent: 'general_chat',
    nextSteps: [
      { label: 'A', actionType: 'MESSAGE' },
      { label: 'B', actionType: 'CALENDAR' },
      { label: 'C', actionType: 'RADAR' },
    ],
  },
  { message: 'ahoj', activeClientName: '' },
);
assert.equal(padded.nextSteps.length, 2);

// Aktivní klient v UI nesmí vstoupit do chatu o jiném případu
const hijack = enrichBrokerNextSteps(
  {
    intent: 'general_chat',
    chatResponse: 'U hypotéky DSTI…',
    nextSteps: [
      { label: 'Doplň kontakt — Barbora Nováková', actionType: 'CLIENT', suggestedMessage: 'Barbora Nováková' },
      { label: 'Radar', actionType: 'RADAR' },
    ],
  },
  { message: 'kolik je DSTI?', activeClientName: 'Barbora Nováková' },
);
assert.ok(!(hijack.nextSteps || []).some((s) => /Barbora/i.test(s.label)));

console.log('brokerNextSteps.selftest OK');
