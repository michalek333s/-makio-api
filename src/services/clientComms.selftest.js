/**
 * Selftest — lidská komunikace (anti-robotické heuristiky + prompt build).
 */
import assert from 'node:assert/strict';
import {
  buildClientMessageSystemPrompt,
  buildNurturingEnhanceSystemPrompt,
  inferDealStage,
  DEAL_STAGES,
  looksRoboticClientMessage,
  sanitizeClientMessageOutput,
} from './clientComms.js';

assert.equal(
  looksRoboticClientMessage('Dobrý den, dovoluji si Vás kontaktovat ohledně nemovitosti.'),
  true,
  'dovoluji si = robotic',
);
assert.equal(
  looksRoboticClientMessage('Váš realitní partner'),
  true,
  'signature = robotic',
);
assert.equal(
  looksRoboticClientMessage('Napiš empatickou SMS pro Petra'),
  true,
  'meta instruction = robotic',
);
assert.equal(
  looksRoboticClientMessage(
    'Ahoj Petro, mám tip na 3+kk s předzahrádkou — hodí se zítra v 17:00 prohlídka?',
  ),
  false,
  'human SMS ok',
);

const smsPrompt = buildClientMessageSystemPrompt({
  channel: 'sms',
  client: {
    name: 'Petr Novák',
    type: 'Zájemce',
    interest: '3+kk Ostrava',
    softData: ['má zlatého retrívra', 'citlivý na cenu'],
  },
  purpose: 'follow-up',
  brokerFirstName: 'Michal',
});
assert.match(smsPrompt, /ZAKÁZANÉ/);
assert.match(smsPrompt, /retrívr|soft data/i);
assert.match(smsPrompt, /KANÁL: SMS/);

assert.match(smsPrompt, /FÁZE OBCHODU/);
assert.match(smsPrompt, /PRVNÍ KONTAKT|Po prohlídce/i);

assert.equal(inferDealStage({ type: 'Prodávající', address_property_sell: 'Ulice 1' }), DEAL_STAGES.LISTING_PITCH);
assert.equal(
  inferDealStage({ type: 'Zájemce', budget: '4 mil' }, { purpose: 'po prohlídce' }),
  DEAL_STAGES.AFTER_VIEWING,
);

assert.equal(looksRoboticClientMessage('Jistě, rád vám pomohu s vaším dotazem.'), true, 'corporate chat = robotic');
assert.equal(looksRoboticClientMessage('Zpracováno.'), true, 'zpracováno = robotic');

const emailPrompt = buildClientMessageSystemPrompt({
  channel: 'email',
  client: { name: 'Jana Prodejová', type: 'Prodávající', address_property_sell: 'Ulice 1' },
});
assert.match(emailPrompt, /SUBJECT/);

const nurturePrompt = buildNurturingEnhanceSystemPrompt();
assert.match(nurturePrompt, /suggestedMessage/);
assert.match(nurturePrompt, /ne roboticky/i);

const long = 'x'.repeat(500);
const cut = sanitizeClientMessageOutput(long, { channel: 'sms' });
assert.ok(cut.length <= 450, 'SMS truncated');

console.log('clientComms.selftest OK');
