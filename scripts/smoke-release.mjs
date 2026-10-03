/**
 * Release smoke — jádro MVP bez JWT (veřejné + lokální knihovny).
 * node scripts/smoke-release.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCorsOrigin } from '../src/lib/corsOrigin.js';
import { resolveWsdpAccessMode } from '../src/lib/wsdpTestMode.js';
import { listContractTemplates } from '../src/services/contractTemplates.js';
import { mapCheckToFullAmlReport, buildAmlProtocolPdf } from '../src/services/amlProtocolPdf.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = process.env.SMOKE_API_URL || 'http://127.0.0.1:3001';

async function getJson(path, opts) {
  const res = await fetch(`${API}${path}`, opts);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { res, data };
}

console.log('── CORS / WSDP / smlouvy (lokálně) ──');
assert.equal(resolveCorsOrigin({ nodeEnv: 'development' }), true);
const templates = listContractTemplates();
assert.equal(templates.length, 3);
assert.ok(templates.every((t) => t.fileExists), 'spusťte npm run contracts:skeletons');
const wsdp = resolveWsdpAccessMode();
console.log('  WSDP mode:', wsdp);
assert.ok(['test', 'credentials', 'none'].includes(wsdp));

console.log('── AML PDF ──');
const mapped = mapCheckToFullAmlReport(
  {
    id: 'smoke-aml-1',
    full_name: 'Smoke Test',
    identifier: '900101/1234',
    client_type: 'natural_person',
    isir_status: 'clean',
    risk_score: 'low',
  },
  { brokerName: 'Test Makléř', agencyName: 'Makio Reality' },
);
assert.notEqual(mapped.brokerName, '—');
assert.match(mapped.agencyName, /Makio Reality/);
const pdf = await buildAmlProtocolPdf(
  {
    id: 'smoke-aml-1',
    full_name: 'Smoke Test',
    identifier: '900101/1234',
    client_type: 'natural_person',
    isir_status: 'clean',
    risk_score: 'low',
    created_at: new Date().toISOString(),
  },
  { brokerName: 'Test Makléř', agencyName: 'Makio Reality' },
);
assert.ok(pdf.length > 5000);
assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 1);
console.log('  PDF', pdf.length, 'B · 1 strana');

console.log('── API health + waitlist ──');
const health = await getJson('/api/health');
assert.equal(health.res.status, 200, 'backend musí běžet na :3001');
assert.equal(health.data.status, 'ok');

const count = await getJson('/api/waitlist/count');
assert.equal(count.res.status, 200);
assert.ok('cap' in count.data);

const email = `smoke+${Date.now()}@makio.test`;
const signup = await getJson('/api/waitlist', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email,
    painPoint: 'crm',
    gdprConsent: true,
  }),
});
assert.ok([200, 409].includes(signup.res.status), `waitlist ${signup.res.status} ${JSON.stringify(signup.data)}`);
console.log('  waitlist', signup.res.status, signup.data.dev ? '(dev log)' : 'ok');

const landingEnv = join(__dirname, '../../nemio-landing/.env');
assert.ok(existsSync(landingEnv), 'nemio-landing/.env');
const landingEnvText = await import('node:fs').then((fs) => fs.readFileSync(landingEnv, 'utf8'));
assert.match(landingEnvText, /VITE_API_URL\s*=\s*http/);

console.log('── contracts smoke ──');
await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [join(__dirname, 'smoke-contracts.mjs')], {
    cwd: join(__dirname, '..'),
    stdio: 'inherit',
  });
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`contracts smoke ${code}`))));
});

console.log('\n✅ smoke-release OK');
