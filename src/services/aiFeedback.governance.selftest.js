/**
 * Governance: neschválený feedback NESMÍ vstoupit do system promptu.
 */
import {
  storeAiFeedback,
  buildFeedbackLessonsForPrompt,
  approveAiFeedbackForContext,
  getMemoryAiFeedback,
} from './aiFeedback.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const stored = await storeAiFeedback({
  input: 'Platím daň po 3 letech vlastnictví a 1 roce bydlení?',
  aiOutput: 'Ne, jste osvobozen.',
  correctedOutput: 'Ano daníte — nesplňujete 5 let ani 2 roky bydlení.',
  feedbackType: 'chat',
  meta: { rating: 'down' },
});

assert(stored.pendingApproval === true, 'nový feedback čeká na schválení');

const before = await buildFeedbackLessonsForPrompt({ limit: 10 });
assert(
  !before.includes('nesplňujete 5 let') && !before.includes('Ano daníte'),
  'neschválená oprava nesmí být v promptu',
);
assert(/žádné schválené|governance/i.test(before) || !before.includes('Ano daníte'), 'prompt bez poison');

const id = stored.id || getMemoryAiFeedback(1)[0]?.id;
assert(id, 'má id');

await approveAiFeedbackForContext({ id, approved: true, approvedBy: null });

const after = await buildFeedbackLessonsForPrompt({ limit: 10 });
assert(after.includes('Ano daníte') || after.includes('5 let'), 'po schválení je lekce v promptu');
assert(after.includes('SCHVÁLENÉHO') || after.includes('Schválené'), 'označení governance');

console.log('aiFeedback.governance.selftest OK');
