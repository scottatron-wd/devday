import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyTokenUsage, estimateCost, sumTokens } from '../src/cost.ts';

test('estimateCost uses known model pricing', () => {
  const tokens = {
    input: 1_000_000,
    output: 500_000,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 1_500_000,
  };

  // gpt-4o: $2.5 input + $10 output per million tokens
  const usd = estimateCost('gpt-4o', tokens);
  assert.equal(usd, 7.5);
});

test('estimateCost falls back for unknown models', () => {
  const tokens = {
    input: 1_000_000,
    output: 1_000_000,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 2_000_000,
  };

  // Fallback: $3 input + $15 output per million tokens
  const usd = estimateCost('unknown-model-xyz', tokens);
  assert.equal(usd, 18);
});

test('sumTokens combines usage correctly', () => {
  const a = {
    input: 10,
    output: 20,
    reasoning: 5,
    cacheRead: 3,
    cacheWrite: 2,
    total: 40,
  };
  const b = {
    input: 4,
    output: 6,
    reasoning: 1,
    cacheRead: 1,
    cacheWrite: 0,
    total: 12,
  };

  const combined = sumTokens(a, b, emptyTokenUsage());
  assert.deepEqual(combined, {
    input: 14,
    output: 26,
    reasoning: 6,
    cacheRead: 4,
    cacheWrite: 2,
    total: 52,
  });
});
