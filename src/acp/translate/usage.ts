import type { UsageUpdate } from '@agentclientprotocol/sdk'

type PiSessionStats = {
  cost?: unknown
  contextUsage?: {
    tokens?: unknown
    contextWindow?: unknown
  } | null
}

export function sessionStatsToUsageUpdate(stats: unknown, fallbackUsed?: number): UsageUpdate | null {
  const sessionStats = stats as PiSessionStats | null
  const contextUsage = sessionStats?.contextUsage
  const size = contextUsage?.contextWindow
  const reportedUsed = contextUsage?.tokens
  const used = typeof reportedUsed === 'number' && Number.isFinite(reportedUsed) ? reportedUsed : fallbackUsed

  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null

  const cost = sessionStats?.cost
  return {
    used,
    size,
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
      ? { cost: { amount: cost, currency: 'USD' } }
      : {})
  }
}
