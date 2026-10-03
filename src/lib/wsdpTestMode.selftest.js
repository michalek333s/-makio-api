/**
 * WSDP test-sample sanitizace.
 *   node src/lib/wsdpTestMode.selftest.js
 */
import {
  isWsdpTestSampleParcel,
  looksLikeWsdpTestOwner,
  resolveWsdpAccessMode,
  sanitizeAnalysisWsdpTest,
} from './wsdpTestMode.js';

process.env.GEOPAS_WSDP_TEST = 'true';
delete process.env.GEOPAS_WSDP_LOGIN;
delete process.env.GEOPAS_WSDP_PASSWORD;

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

assert('access mode test', resolveWsdpAccessMode() === 'test');
assert('fingerprint Kratochvíl', looksLikeWsdpTestOwner('Roman Kratochvíl'));
assert(
  'parcel flagged by env',
  isWsdpTestSampleParcel({ owner: 'Někdo', lv: '1082' }, 'credentials') === true,
);

const dirty = {
  owner: 'Roman Kratochvíl',
  owners: ['Roman Kratochvíl'],
  lv: '1913',
  ownerAccess: 'credentials',
  isTestOwner: false,
  risks: { liens: [{ type: 'Exekuce' }], hasExecution: true, hasMortgage: false },
  dataQuality: { overall: 'live', fields: {} },
};

const clean = sanitizeAnalysisWsdpTest(dirty);
assert('sanitize clears owner', clean.owner == null, clean.owner);
assert('sanitize clears owners', Array.isArray(clean.owners) && clean.owners.length === 0);
assert('sanitize lv dash', clean.lv === '—');
assert('sanitize isTestOwner', clean.isTestOwner === true);
assert('sanitize access test', clean.ownerAccess === 'test');
assert('sanitize clears liens', clean.risks.liens.length === 0);
assert('sanitize not live DQ', clean.dataQuality.overall === 'partial');

process.env.GEOPAS_WSDP_TEST = 'false';
process.env.GEOPAS_WSDP_LOGIN = 'real';
process.env.GEOPAS_WSDP_PASSWORD = 'secret';
assert('access credentials when test off', resolveWsdpAccessMode() === 'credentials');
assert(
  'live parcel not flagged',
  isWsdpTestSampleParcel({ owner: 'Jan Novák', lv: '1082', isTestSample: false }, 'credentials') ===
    false,
);

console.log(failed ? `\nFAILED ${failed}` : '\nAll passed');
process.exit(failed ? 1 : 0);
