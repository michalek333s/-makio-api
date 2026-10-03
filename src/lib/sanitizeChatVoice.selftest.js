import assert from 'node:assert/strict';
import {
  sanitizeChatVoice,
  looksLikeApologyOrTypoTalk,
  ensureUsefulChatResponse,
} from './sanitizeChatVoice.js';

assert.equal(
  looksLikeApologyOrTypoTalk('Omlouvám se, v textu je překlep. Chyby se stávají.'),
  true,
);

const cleaned = sanitizeChatVoice(
  'Omlouvám se, v textu je překlep. U hypotéky počítejte DSTI 40 %.',
);
assert.match(cleaned, /DSTI/i);
assert.doesNotMatch(cleaned, /omlouvám|překlep/i);

const parsed = ensureUsefulChatResponse(
  { intent: 'clarification_needed', chatResponse: 'Omluvte mě, nerozumím.' },
  'co s cenou',
);
assert.match(parsed.chatResponse, /5–12 %|Radar|kro/i);
assert.equal(parsed.intent, 'general_chat');

console.log('sanitizeChatVoice.selftest OK');
