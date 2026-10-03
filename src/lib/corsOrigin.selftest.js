import assert from 'node:assert/strict';
import { resolveCorsOrigin } from './corsOrigin.js';

assert.equal(resolveCorsOrigin({ nodeEnv: 'development' }), true);

assert.equal(
  resolveCorsOrigin({ nodeEnv: 'production', frontendUrl: 'https://app.makio.cz' }),
  'https://app.makio.cz',
);

assert.equal(resolveCorsOrigin({ nodeEnv: 'production', frontendUrl: '' }), false);

const multi = resolveCorsOrigin({
  nodeEnv: 'production',
  frontendUrl: 'https://app.makio.cz',
  frontendUrls: 'https://makio.cz, https://www.makio.cz/',
});
assert.equal(typeof multi, 'function');

await new Promise((resolve, reject) => {
  multi('https://makio.cz', (err, ok) => (err || !ok ? reject(err || new Error('fail')) : resolve()));
});
await new Promise((resolve, reject) => {
  multi('https://evil.test', (err) => (err ? resolve() : reject(new Error('should block'))));
});

console.log('corsOrigin.selftest OK');
