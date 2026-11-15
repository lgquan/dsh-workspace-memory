import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

const clientSource = readFileSync(fileURLToPath(new URL('../src/client/index.tsx', import.meta.url)), 'utf8')

test('memory edit save button uses the Host primary-button color pair', () => {
  assert.match(clientSource, /primaryFill:\s*'var\(--dsw-alias-button-primary-fill/u)
  assert.match(clientSource, /onPrimary:\s*'var\(--dsw-alias-label-primary-foreground/u)
  assert.match(clientSource, /color:\s*colors\.onPrimary,\s*background:\s*colors\.primaryFill/u)
  assert.doesNotMatch(clientSource, /color:\s*'#fff',\s*background:\s*colors\.accent/u)
})

test('memory settings show daily and cumulative tokens only for workspace scopes', () => {
  assert.match(clientSource, /todayTokenUsage:\s*'今日整理'/u)
  assert.match(clientSource, /totalTokenUsage:\s*'累计整理'/u)
  assert.match(clientSource, /displayedPayload\?\.scope\.kind === 'workspace' && h\('div'/u)
  assert.doesNotMatch(clientSource, /failedCalls:\s*'失败调用'/u)
  assert.doesNotMatch(clientSource, /distillCalls:\s*'整理调用'/u)
  assert.match(clientSource, /state\.distillation\.totalTokens/u)
  assert.match(clientSource, /state\.distillation\.todayTokens/u)
  assert.match(clientSource, /formatTokenUsage\(totalTokens\)/u)
  assert.match(clientSource, /title:\s*exactTokenUsage\(totalTokens\)/u)
  assert.match(clientSource, /cacheHitTokens:\s*'缓存命中'/u)
  assert.match(clientSource, /cacheHitRate:\s*'命中率'/u)
  assert.match(clientSource, /tokenUsageRow\(/u)
  assert.match(clientSource, /state\.processing\.phase === 'blocked'/u)
  assert.match(clientSource, /workspace-memory\/api\/v1\/retry/u)
})

test('summary area explains queued semantic refreshes and their expected wait', () => {
  assert.match(clientSource, /summaryUpdating:\s*'摘要正在更新'/u)
  assert.match(clientSource, /summaryStartsIn:\s*'预计约 \{seconds\} 秒后开始'/u)
  assert.match(clientSource, /summaryModelDuration:\s*'模型生成通常还需几十秒'/u)
  assert.match(clientSource, /state\.summaryRefresh/u)
  assert.match(clientSource, /summaryRefresh\.topics/u)
})
