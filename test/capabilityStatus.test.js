import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRadarDemoFallbackEnabled, getDemoRadarListings } from '../src/data/radarDemoListings.js';
import { getCapabilityStatus } from '../src/services/capabilityStatus.js';

test('Radar demo fallback je jen opt-in, i v development', () => {
  const prevF = process.env.RADAR_DEMO_FALLBACK;
  const prevN = process.env.NODE_ENV;
  delete process.env.RADAR_DEMO_FALLBACK;
  process.env.NODE_ENV = 'development';
  assert.equal(isRadarDemoFallbackEnabled(), false);
  assert.equal(getDemoRadarListings('Moravskoslezský').length, 0);

  process.env.RADAR_DEMO_FALLBACK = '1';
  assert.equal(isRadarDemoFallbackEnabled(), true);
  assert.ok(getDemoRadarListings('Moravskoslezský').length > 0);

  if (prevF === undefined) delete process.env.RADAR_DEMO_FALLBACK;
  else process.env.RADAR_DEMO_FALLBACK = prevF;
  if (prevN === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevN;
});

test('capability status vrací jádro položek bez tajemství', () => {
  const s = getCapabilityStatus();
  assert.ok(Array.isArray(s.items));
  const ids = s.items.map((i) => i.id);
  assert.ok(ids.includes('auth'));
  assert.ok(ids.includes('crm'));
  assert.ok(ids.includes('radar'));
  assert.ok(ids.includes('wsdp'));
  assert.equal(s.items.some((i) => /sk-|AIza|eyJ/.test(JSON.stringify(i))), false);
});
