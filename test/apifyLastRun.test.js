import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isApifyQuotaError, shouldSalvageLastApifyRun } from '../src/services/apifyLastRun.js';

describe('apifyLastRun helpers', () => {
  it('detects quota / dataset-locked', () => {
    assert.equal(isApifyQuotaError({ status: 403, message: 'forbidden' }), true);
    assert.equal(
      isApifyQuotaError(new Error('Monthly usage hard limit exceeded')),
      true,
    );
    assert.equal(isApifyQuotaError(new Error('dataset-locked for this actor')), true);
    assert.equal(isApifyQuotaError({ code: 'APIFY_QUOTA', message: 'x' }), true);
  });

  it('salvages on start failures and network', () => {
    assert.equal(
      shouldSalvageLastApifyRun(new Error('Nepodařilo se spustit žádný Apify běh.')),
      true,
    );
    assert.equal(shouldSalvageLastApifyRun(new Error('fetch failed')), true);
    assert.equal(shouldSalvageLastApifyRun(null), true);
  });
});
