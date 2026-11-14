export function formatTokenUsage(value: number): string {
  const tokens = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
  if (tokens < 1_000) return `${String(tokens)} Token`
  const divisor = tokens < 1_000_000 ? 1_000 : 1_000_000
  const suffix = tokens < 1_000_000 ? 'K' : 'M'
  const compact = Math.round(tokens / divisor * 100) / 100
  return `${String(compact)}${suffix} Token`
}

export function exactTokenUsage(value: number): string {
  const tokens = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
  return `${tokens.toLocaleString('en-US')} Token`
}

export function formatCacheHitRate(cacheReadTokens: number, inputTokens: number, cacheWriteTokens: number): string {
  const cacheRead = Number.isFinite(cacheReadTokens) ? Math.max(0, cacheReadTokens) : 0
  const input = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0
  const cacheWrite = Number.isFinite(cacheWriteTokens) ? Math.max(0, cacheWriteTokens) : 0
  const promptTokens = input + cacheRead + cacheWrite
  if (promptTokens === 0) return '0%'
  const percentage = Math.round(cacheRead / promptTokens * 1_000) / 10
  return `${String(percentage)}%`
}
