import assert from 'node:assert/strict'
import { test } from 'vitest'
import { exactTokenUsage, formatCacheHitRate, formatTokenUsage } from '../src/client/format.ts'

test('formats token usage with adaptive K and M units', () => {
  const examples: Array<[number, string]> = [
    [0, '0 Token'],
    [860, '860 Token'],
    [1_000, '1K Token'],
    [3_280, '3.28K Token'],
    [86_500, '86.5K Token'],
    [1_000_000, '1M Token'],
    [1_240_000, '1.24M Token'],
  ]
  for (const [value, expected] of examples) assert.equal(formatTokenUsage(value), expected)
  assert.equal(formatTokenUsage(Number.NaN), '0 Token')
  assert.equal(formatTokenUsage(-100), '0 Token')
})

test('keeps the exact token count available for hover text', () => {
  assert.equal(exactTokenUsage(86_500), '86,500 Token')
})

test('calculates cache hit rate from prompt-side tokens only', () => {
  assert.equal(formatCacheHitRate(8_198, 5_017, 0), '62%')
  assert.equal(formatCacheHitRate(500, 400, 100), '50%')
  assert.equal(formatCacheHitRate(0, 0, 0), '0%')
})
