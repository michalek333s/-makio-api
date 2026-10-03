import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowMemoryCredits,
  getCreditsBalance,
  deductCredits,
  refundCredits,
  grantCredits,
  resetMemoryCreditsForTests,
} from '../src/services/credits.js';

const KEYS = [
  'NODE_ENV',
  'CREDITS_FAIL_CLOSED',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DEV_CREDITS_TOPUP',
];

async function withEnv(patch, fn) {
  const prev = {};
  for (const k of KEYS) prev[k] = process.env[k];
  for (const k of KEYS) {
    if (!(k in patch)) continue;
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  resetMemoryCreditsForTests();
  try {
    await fn();
  } finally {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    resetMemoryCreditsForTests();
  }
}

const noSupabase = {
  SUPABASE_URL: undefined,
  SUPABASE_SERVICE_ROLE_KEY: undefined,
  DEV_CREDITS_TOPUP: undefined,
};

test('dev bez Supabase: RAM ledger je povolený', async () => {
  await withEnv({ NODE_ENV: 'development', CREDITS_FAIL_CLOSED: undefined, ...noSupabase }, async () => {
    assert.equal(allowMemoryCredits(), true);
    const uid = 'user-dev-1';
    const bal = await getCreditsBalance(uid);
    assert.equal(bal.source, 'memory');
    assert.ok(bal.balance >= 1);
    const after = await deductCredits(uid, 1, { sourceRef: 'test' });
    assert.equal(after.source, 'memory');
    assert.equal(after.balance, bal.balance - 1);
  });
});

test('production bez Supabase: žádný RAM fallback (503)', async () => {
  await withEnv({ NODE_ENV: 'production', CREDITS_FAIL_CLOSED: undefined, ...noSupabase }, async () => {
    assert.equal(allowMemoryCredits(), false);
    await assert.rejects(() => getCreditsBalance('user-prod-1'), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'CREDITS_UNAVAILABLE');
      return true;
    });
    await assert.rejects(() => deductCredits('user-prod-1', 1), (err) => {
      assert.equal(err.status, 503);
      return true;
    });
    await assert.rejects(() => refundCredits('user-prod-1', 1), (err) => {
      assert.equal(err.status, 503);
      return true;
    });
  });
});

test('CREDITS_FAIL_CLOSED=1 v development: stejné jako produkce', async () => {
  await withEnv({ NODE_ENV: 'development', CREDITS_FAIL_CLOSED: '1', ...noSupabase }, async () => {
    assert.equal(allowMemoryCredits(), false);
    await assert.rejects(() => getCreditsBalance('user-closed-1'), (err) => err.status === 503);
  });
});

test('grantCredits v development RAM ledgeru', async () => {
  await withEnv({ NODE_ENV: 'development', CREDITS_FAIL_CLOSED: undefined, ...noSupabase }, async () => {
    const uid = 'user-grant-1';
    const before = await getCreditsBalance(uid);
    const after = await grantCredits(uid, 10, { sourceRef: 'test_topup' });
    assert.equal(after.granted, 10);
    assert.equal(after.balance, before.balance + 10);
  });
});
