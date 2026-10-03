import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeuristicColdCall } from '../src/services/radarColdCall.js';

test('cold-call heuristika vrací JSON tvar script + bullets + talking points', () => {
  const h = buildHeuristicColdCall({
    locality: 'Ostrava, Poruba',
    layout: '2+kk',
    floorArea: 46,
    source: 'bazos',
    radarStatus: 'NEW_PRIVATE',
  });
  assert.equal(typeof h.script, 'string');
  assert.ok(h.script.length >= 40);
  assert.ok(Array.isArray(h.bulletPoints) && h.bulletPoints.length >= 3);
  assert.ok(Array.isArray(h.suggestedTalkingPoints) && h.suggestedTalkingPoints.length >= 3);
  assert.equal(h.provider, 'heuristic');
  assert.equal(h.source, 'heuristic');
  assert.ok(/RK nevolat/i.test(h.script));
  assert.ok(/kávu|odhad/i.test(h.script));
});
