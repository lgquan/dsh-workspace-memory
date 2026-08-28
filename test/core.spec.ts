import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test } from 'vitest'
import {
  WorkspaceMemoryEngine,
  WorkspaceMemoryStore,
  checkpointEligible,
  lexicalTokens,
  normalizeWorkspacePath,
  scopeKeyForCwd,
  searchEntries,
  type DistillInput,
  type MemoryEngineConfig,
  type MemoryProposal,
  type MemoryState,
} from '../src/core.ts'

function sequenceUuid() {
  let value = 0
  return () => `00000000-0000-0000-0000-${String(++value).padStart(12, '0')}`
}

interface FixtureOptions {
  config?: Partial<MemoryEngineConfig>
  proposals?: readonly MemoryProposal[]
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-'))
  let now = Date.parse('2026-08-29T00:00:00.000Z')
  const store = new WorkspaceMemoryStore(root, { now: () => now, uuid: sequenceUuid() })
  const calls: DistillInput[] = []
  const engine = new WorkspaceMemoryEngine({
    store,
    config: {
      checkpointTurns: 2,
      checkpointChars: 100,
      idleCheckpointMs: 1000,
      consolidateEvery: 2,
      summaryMaxBytes: 2000,
      recallMaxBytes: 3000,
      ...options.config,
    },
    distill: async input => {
      calls.push(input)
      return options.proposals ?? [{ content: '项目的语音前台聊天绕过 Agent Loop。', tags: ['project', 'voice'], importance: 2 }]
    },
  })
  return {
    root,
    store,
    engine,
    calls,
    advance(ms: number) { now += ms },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('normalizes Windows workspace identity before hashing', () => {
  assert.equal(normalizeWorkspacePath('D:\\Work\\Project\\', 'win32'), 'd:/work/project')
  assert.equal(scopeKeyForCwd('D:\\Work\\Project', 'win32'), scopeKeyForCwd('d:/work/project/', 'win32'))
  assert.equal(scopeKeyForCwd(''), 'global')
})

test('tokenizes ASCII words and Chinese bigrams without BM25', () => {
  const tokens = lexicalTokens('Voice Agent 能读取长期记忆')
  assert.ok(tokens.includes('voice'))
  assert.ok(tokens.includes('agent'))
  assert.ok(tokens.includes('长期'))
  assert.ok(tokens.includes('记忆'))
})

test('ranks exact and CJK-related entries', () => {
  const entries = [
    { id: 'a', content: '语音前台聊天绕过 Agent Loop。', tags: ['voice'], importance: 2, updatedAt: '2026-08-28T00:00:00Z' },
    { id: 'b', content: '数据库使用 PostgreSQL。', tags: ['database'], importance: 3, updatedAt: '2026-08-29T00:00:00Z' },
  ]
  assert.equal(searchEntries(entries, '语音聊天为什么绕过 Agent', { now: Date.parse('2026-08-29T00:00:00Z') })[0]?.entry.id, 'a')
  assert.equal(searchEntries(entries, 'PostgreSQL database', { now: Date.parse('2026-08-29T00:00:00Z') })[0]?.entry.id, 'b')
})

test('buffers until a logical stage and deduplicates message ids', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-a')
  const first = await f.engine.checkpoint({
    cwd,
    reason: 'segment-end',
    messages: [{ id: 'u1', role: 'user', text: '我们正在讨论语音插件。' }],
  })
  assert.equal(first.status, 'buffered')
  assert.equal(first.accepted, 1)
  assert.equal(f.calls.length, 0)

  const second = await f.engine.checkpoint({
    cwd,
    reason: 'segment-end',
    messages: [
      { id: 'u1', role: 'user', text: '重复消息不会再次进入。' },
      { id: 'a1', role: 'assistant', text: '这是中间回复。' },
      { id: 'u2', role: 'user', text: '现在形成了第二轮。' },
    ],
  })
  assert.equal(second.status, 'committed')
  assert.equal(second.accepted, 2)
  assert.equal(second.added, 1)
  assert.equal(f.calls.length, 1)

  const repeated = await f.engine.checkpoint({
    cwd,
    reason: 'segment-end',
    messages: [{ id: 'u2', role: 'user', text: '重复。' }],
  })
  assert.equal(repeated.status, 'empty')
  assert.equal(repeated.accepted, 0)
})

test('shares memory for the same cwd and isolates another workspace', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const firstCwd = join(f.root, 'workspace-a')
  const secondCwd = join(f.root, 'workspace-b')
  await f.engine.checkpoint({
    cwd: firstCwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u1', role: 'user', text: '确定语音前台聊天绕过 Agent Loop。' }],
  })
  const shared = await f.engine.recall({ cwd: firstCwd, query: '语音聊天 Agent' })
  const isolated = await f.engine.recall({ cwd: secondCwd, query: '语音聊天 Agent' })
  assert.equal(shared.matches[0]?.content, '项目的语音前台聊天绕过 Agent Loop。')
  assert.match(shared.summary, /语音前台/u)
  assert.equal(isolated.matches.length, 0)
  assert.equal(isolated.summary, '')
})

test('updates a near-duplicate instead of appending another entry', async () => {
  const f = await fixture({ proposals: [{ content: '项目语音前台会绕过 Agent Loop。', tags: ['voice'], importance: 3 }] })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-a')
  await f.engine.remember({ cwd, content: '项目的语音前台绕过 Agent Loop。', tags: ['project'], importance: 1 })
  const result = await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u1', role: 'user', text: '确认新的表达。' }],
  })
  assert.equal(result.updated, 1)
  const entries = await f.store.readEntries(f.store.scope(cwd))
  assert.equal(entries.filter(entry => entry.status !== 'deleted').length, 1)
  assert.equal(entries[0]?.importance, 3)
})

test('idle policy is a fallback rather than an hourly schedule', () => {
  const state: Pick<MemoryState, 'pendingMessages' | 'lastBufferedAt'> = {
    pendingMessages: [{ id: 'u1', role: 'user', text: '一条未满阈值的内容。' }],
    lastBufferedAt: 1000,
  }
  const config = { checkpointTurns: 10, checkpointChars: 4000, idleCheckpointMs: 5000 }
  assert.equal(checkpointEligible(state, 'segment-end', config, 5999), false)
  assert.equal(checkpointEligible(state, 'segment-end', config, 6000), true)
  assert.equal(checkpointEligible(state, 'idle', config, 1001), true)
})

test('rejects credential-shaped explicit memories', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  await assert.rejects(
    f.engine.remember({ cwd: join(f.root, 'workspace'), content: 'api_key=sk-abcdefghijklmnop' }),
    /credential-like secret/u,
  )
})

test('keeps only the configured number of previous summaries', async () => {
  const f = await fixture({ config: { keepSummaryVersions: 1 } })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace')
  await f.engine.remember({ cwd, content: '第一条长期事实。' })
  await f.engine.remember({ cwd, content: '第二条长期事实。' })
  await f.engine.remember({ cwd, content: '第三条长期事实。' })
  const scope = f.store.scope(cwd)
  const history = await readdir(join(scope.dir, 'summary_history'))
  assert.equal(history.length, 1)
})
