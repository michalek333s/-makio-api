/**
 * Selftest — prompt stack pro chat (mastery + deal stages + anti-robot).
 */
import assert from 'node:assert/strict';
import { buildNemioChatSystemPrompt } from '../prompts/buildNemioChatSystemPrompt.js';
import { looksRoboticClientMessage } from './clientComms.js';

const now = new Date();
const prompt = await buildNemioChatSystemPrompt({
  currentDate: now.toLocaleDateString('cs-CZ'),
  currentTime: now.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }),
  referenceDateIso: now.toISOString().slice(0, 10),
  clientsContext: 'Žádní klienti',
  historyBlock: '',
  activeClientName: '',
  brokerFirstName: 'Michale',
});

assert.match(prompt, /HYPOTÉKY — OD PRVNÍHO ROZHOVORU/i, 'mastery hypotéky');
assert.match(prompt, /NOVOSTAVBY & DEVELOPERSKÉ PROJEKTY/i, 'mastery novostavby');
assert.match(prompt, /REKONSTRUKCE, PŘESTAVBY/i, 'mastery rekonstrukce');
assert.match(prompt, /POZEMKY — NÁKUP/i, 'mastery pozemky');
assert.match(prompt, /FÁZE 1: PRVNÍ KONTAKT/i, 'deal stages');
assert.match(prompt, /ČÁST 11: LIDSKÝ HLAS/i, 'human voice rules');
assert.match(prompt, /omluvte mě/i, 'ban apology phrasing');
assert.match(prompt, /VŽDY ODPOVĚĎ \+ DALŠÍ KROK/i, 'always answer + next step');
assert.match(prompt, /ZAKÁZANÉ \(robotický tón\)/i, 'client comms');
assert.ok(prompt.length > 15_000, 'prompt stack is substantial');

assert.equal(looksRoboticClientMessage('Jistě, rád vám pomohu…'), true);

console.log('chatPromptStack.selftest OK');
