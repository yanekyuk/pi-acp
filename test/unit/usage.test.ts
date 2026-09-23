import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionStatsToUsageUpdate } from '../../src/acp/translate/usage.js'

test('sessionStatsToUsageUpdate maps pi context and cumulative cost to ACP usage', () => {
  assert.deepEqual(
    sessionStatsToUsageUpdate({
      cost: 1.25,
      contextUsage: { tokens: 12_345, contextWindow: 128_000, percent: 9.64 }
    }),
    {
      used: 12_345,
      size: 128_000,
      cost: { amount: 1.25, currency: 'USD' }
    }
  )
})

test('sessionStatsToUsageUpdate uses a compaction estimate when pi context usage is temporarily unknown', () => {
  assert.deepEqual(
    sessionStatsToUsageUpdate(
      {
        cost: 0.5,
        contextUsage: { tokens: null, contextWindow: 200_000, percent: null }
      },
      8_000
    ),
    {
      used: 8_000,
      size: 200_000,
      cost: { amount: 0.5, currency: 'USD' }
    }
  )
})

test('sessionStatsToUsageUpdate omits updates when context usage is unavailable', () => {
  assert.equal(sessionStatsToUsageUpdate({ cost: 1, contextUsage: { tokens: null, contextWindow: 128_000 } }), null)
  assert.equal(sessionStatsToUsageUpdate({ cost: 1, contextUsage: null }), null)
})
