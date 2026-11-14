import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test } from 'vitest'
import {
  WorkspaceMemoryEngine,
  WorkspaceMemoryStore,
  checkpointEligible,
  distillationCandidateBytes,
  lexicalTokens,
  normalizeWorkspacePath,
  selectDistillationCandidates,
  scopeKeyForCwd,
  searchEntries,
  type DistillInput,
  type MemoryEngineConfig,
  type MemoryProposal,
  type MemoryState,
} from '../src/core.ts'

function sequenceUuid() {
  let value = 0
  return () => `${String(++value).padStart(8, '0')}-0000-0000-0000-000000000000`
}

interface FixtureOptions {
  config?: Partial<MemoryEngineConfig>
  proposals?: readonly MemoryProposal[]
  distilled?: unknown
  distill?: (input: DistillInput) => unknown
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
      return options.distill?.(input) ?? options.distilled ?? options.proposals ?? [{ content: '项目的语音前台聊天绕过 Agent Loop。', tags: ['project', 'voice'], importance: 2 }]
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

test('selects bounded distillation candidates from user text without recent-memory fallback', () => {
  const entries = [
    { id: 'location', content: '用户现居上海市。', title: '现居城市', tags: ['profile'], status: 'active' as const },
    { id: 'tts', content: 'Qwen TTS 按字符计费。', title: 'TTS 定价', tags: ['tts'], status: 'active' as const, updatedAt: '2099-01-01T00:00:00Z' },
  ]
  const selected = selectDistillationCandidates(entries, [
    { id: 'u1', role: 'user', text: '我现在住在上海市。' },
    { id: 'a1', role: 'assistant', text: '这与 Qwen TTS 定价没有关系。' },
  ])
  assert.deepEqual(selected.map(entry => entry.id), ['location'])
  assert.deepEqual(selectDistillationCandidates(entries, [{ id: 'u2', role: 'user', text: '今天天气不错。' }]), [])
  assert.deepEqual(selectDistillationCandidates(entries, [{ id: 'a2', role: 'assistant', text: '用户现居上海市。' }]), [])
})

test('caps distillation candidates at six entries and three kilobytes by default', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    id: `database-${String(index)}`,
    content: `项目数据库候选 ${String(index)}：${'数据库内容'.repeat(80)}`,
    title: `数据库候选 ${String(index)}`,
    tags: ['database'],
    status: 'active' as const,
  }))
  const selected = selectDistillationCandidates(entries, [{ id: 'u1', role: 'user', text: '项目数据库如何选择？' }])
  assert.ok(selected.length <= 6)
  assert.ok(selected.reduce((total, entry) => total + distillationCandidateBytes(entry), 0) <= 3_000)
})

test('tracks workspace distillation tokens by local calendar day', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-daily-tokens-'))
  let now = new Date(2026, 10, 14, 23, 55).getTime()
  const store = new WorkspaceMemoryStore(root, { now: () => now })
  const scope = store.scope(join(root, 'workspace'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))

  await store.recordDistillationCall(scope, { failed: false, finishReason: 'stop', inputTokens: 20, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80 })
  const firstDay = await store.readState(scope)
  assert.equal(firstDay.distillation.todayDate, '2026-11-14')
  assert.equal(firstDay.distillation.todayTokens, 120)
  assert.equal(firstDay.distillation.todayInputTokens, 20)
  assert.equal(firstDay.distillation.todayCacheReadTokens, 80)
  assert.equal(firstDay.distillation.todayCacheWriteTokens, 0)
  assert.equal(firstDay.distillation.totalTokens, 120)

  now = new Date(2026, 10, 15, 0, 5).getTime()
  const afterMidnight = await store.readState(scope)
  assert.equal(afterMidnight.distillation.todayDate, '2026-11-15')
  assert.equal(afterMidnight.distillation.todayTokens, 0)
  assert.equal(afterMidnight.distillation.todayInputTokens, 0)
  assert.equal(afterMidnight.distillation.todayCacheReadTokens, 0)
  assert.equal(afterMidnight.distillation.totalTokens, 120)

  await store.recordDistillationCall(scope, { failed: false, finishReason: 'stop', inputTokens: 10, outputTokens: 5, totalTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 5 })
  const secondDay = await store.readState(scope)
  assert.equal(secondDay.distillation.todayTokens, 30)
  assert.equal(secondDay.distillation.todayInputTokens, 10)
  assert.equal(secondDay.distillation.todayCacheReadTokens, 10)
  assert.equal(secondDay.distillation.todayCacheWriteTokens, 5)
  assert.equal(secondDay.distillation.totalTokens, 150)
})

test('ranks exact and CJK-related entries', () => {
  const entries = [
    { id: 'a', content: '语音前台聊天绕过 Agent Loop。', tags: ['voice'], importance: 2, updatedAt: '2026-08-28T00:00:00Z' },
    { id: 'b', content: '数据库使用 PostgreSQL。', tags: ['database'], importance: 3, updatedAt: '2026-08-29T00:00:00Z' },
  ]
  assert.equal(searchEntries(entries, '语音聊天为什么绕过 Agent', { now: Date.parse('2026-08-29T00:00:00Z') })[0]?.entry.id, 'a')
  assert.equal(searchEntries(entries, 'PostgreSQL database', { now: Date.parse('2026-08-29T00:00:00Z') })[0]?.entry.id, 'b')
})

test('only rewards retrieval terms that overlap the query', () => {
  const entries = [
    { id: 'with-terms', content: '数据库使用 PostgreSQL。', retrievalTerms: ['washout', '治疗间隔'], importance: 1 },
    { id: 'without-terms', content: '数据库使用 PostgreSQL。', importance: 1 },
  ]
  const results = searchEntries(entries, '数据库')
  assert.equal(results[0]?.score, results[1]?.score)
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
  assert.equal(shared.summary, '')
  assert.equal(isolated.matches.length, 0)
  assert.equal(isolated.summary, '')
})

test('does not block recall while checkpoint distillation is running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-lock-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const store = new WorkspaceMemoryStore(root)
  let releaseDistill!: () => void
  const distillStarted = new Promise<void>(resolve => {
    releaseDistill = resolve
  })
  const engine = new WorkspaceMemoryEngine({
    store,
    config: { checkpointTurns: 1 },
    distill: async () => {
      await distillStarted
      return [{ content: '蒸馏完成后的项目事实。' }]
    },
  })
  const cwd = join(root, 'workspace')
  const checkpoint = engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u1', role: 'user', text: '记录一条项目事实。' }],
  })
  await new Promise<void>(resolve => setImmediate(resolve))
  const recall = engine.recall({ cwd, query: '项目事实' })
  try {
    const result = await Promise.race([
      recall.then(() => 'resolved' as const),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 50)),
    ])
    assert.equal(result, 'resolved')
  } finally {
    releaseDistill()
  }
  assert.equal((await checkpoint).status, 'committed')
})

test('preserves messages appended while an earlier checkpoint is distilling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-concurrent-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const store = new WorkspaceMemoryStore(root)
  let signalDistillStarted!: () => void
  const distillStarted = new Promise<void>(resolve => { signalDistillStarted = resolve })
  let releaseDistill!: () => void
  const distillReleased = new Promise<void>(resolve => { releaseDistill = resolve })
  const engine = new WorkspaceMemoryEngine({
    store,
    distill: async () => {
      signalDistillStarted()
      await distillReleased
      return [{ content: '第一批消息形成的长期事实。' }]
    },
  })
  const cwd = join(root, 'workspace')
  const first = engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u1', role: 'user', text: '第一批消息。' }],
  })
  await distillStarted
  const second = await engine.checkpoint({
    cwd,
    reason: 'segment-end',
    messages: [{ id: 'u2', role: 'user', text: '蒸馏期间追加的消息。' }],
  })
  assert.equal(second.status, 'buffered')
  assert.equal(second.pending, 2)
  releaseDistill()
  const committed = await first
  assert.equal(committed.pending, 1)
  const state = await store.readState(store.scope(cwd))
  assert.deepEqual(state.pendingMessages.map(message => message.id), ['u2'])
})

test('invalidates the recall snapshot after a memory write', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-cache')
  assert.equal((await f.engine.recall({ cwd, query: '缓存事实' })).matches.length, 0)
  await f.engine.remember({ cwd, content: '写入后必须立即可见的缓存事实。' })
  assert.equal((await f.engine.recall({ cwd, query: '缓存事实' })).matches[0]?.content, '写入后必须立即可见的缓存事实。')
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

test('deferred checkpoints persist messages without calling the distiller', async () => {
  const f = await fixture({ config: { checkpointTurns: 1 } })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'deferred-workspace')
  const buffered = await f.engine.checkpoint({
    cwd,
    reason: 'segment-end',
    defer: true,
    messages: [{ id: 'deferred-user', role: 'user', text: '完整轮次先进入后台队列。' }],
  })
  assert.equal(buffered.status, 'buffered')
  assert.equal(f.calls.length, 0)
  assert.equal((await f.store.readState(f.store.scope(cwd))).pendingMessages.length, 1)

  const committed = await f.engine.checkpoint({ cwd, reason: 'idle', messages: [] })
  assert.equal(committed.status, 'committed')
  assert.equal(f.calls.length, 1)
  assert.equal((await f.store.readState(f.store.scope(cwd))).pendingMessages.length, 0)
})

test('rejects credential-shaped explicit memories', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  await assert.rejects(
    f.engine.remember({ cwd: join(f.root, 'workspace'), content: 'api_key=sk-abcdefghijklmnop' }),
    /credential-like secret/u,
  )
})

test('keeps only the configured number of semantic generations', async () => {
  const f = await fixture({ config: { keepSummaryVersions: 1 } })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace')
  const scope = f.store.scope(cwd)
  await f.engine.remember({ cwd, content: '第一条长期事实。' })
  for (const content of ['第一版语义内容。', '第二版语义内容。', '第三版语义内容。']) {
    const prepared = await f.store.prepareSemanticSummary(scope, 0)
    assert.equal(prepared.status, 'ready')
    if (prepared.status !== 'ready') throw new Error('semantic representation was not ready')
    await f.store.commitSemanticSummary(scope, prepared, [{ id: 'project-overview', content, sourceIds: prepared.dirtyTopics[0]?.entries.map(entry => entry.id) ?? [] }], 2000, 1)
    f.advance(1)
  }
  const generations = await readdir(join(scope.dir, 'representations', 'generations'))
  assert.equal(generations.length, 1)
})

test('publishes validated semantic topics and invalidates only dirty content after mutation', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-semantic-summary')
  await f.engine.remember({ cwd, content: '用户现居上海市。', title: '现居城市', description: '用户长期居住在上海' })
  const scope = f.store.scope(cwd)
  const entry = (await f.store.readEntries(scope))[0]
  assert.ok(entry)
  assert.equal(await f.store.readSummary(scope), '')
  const prepared = await f.store.prepareSemanticSummary(scope, 0)
  assert.equal(prepared.status, 'ready')
  if (prepared.status !== 'ready') throw new Error('semantic summary was not ready')
  assert.equal(await f.store.commitSemanticSummary(
    scope,
    prepared,
    [{ id: 'architecture', content: '现居火星。', sourceIds: [entry.id] }],
    2000,
    2,
  ), false)
  assert.doesNotMatch(await f.store.readSummary(scope), /火星/u)
  assert.equal(await f.store.commitSemanticSummary(
    scope,
    prepared,
    [{ id: 'project-overview', content: '用户画像：现居上海。', sourceIds: [entry.id] }],
    2000,
    2,
  ), true)
  assert.ok(await f.store.readRepresentationManifest(scope))
  assert.match(await f.store.readSummary(scope), /用户画像：现居上海/u)

  await f.engine.remember({ cwd, content: '项目采用事件驱动架构。', type: 'architecture', title: '项目架构' })
  const architecture = await f.store.prepareSemanticSummary(scope, 86_400_000)
  assert.equal(architecture.status, 'ready')
  if (architecture.status !== 'ready') throw new Error('architecture topic was not ready')
  assert.deepEqual(architecture.dirtyTopics.map(topic => topic.id), ['architecture'])
  assert.equal(await f.store.commitSemanticSummary(
    scope,
    architecture,
    [{ id: 'architecture', content: '项目采用事件驱动架构。', sourceIds: architecture.dirtyTopics[0]?.entries.map(item => item.id) ?? [] }],
    2000,
    2,
  ), true)
  assert.match(await f.store.readTopic(scope, 'architecture'), /事件驱动/u)

  await f.engine.update({ cwd, id: entry.id, content: '用户现居北京市。', title: '现居城市', description: '用户长期居住在北京' })
  assert.doesNotMatch(await f.store.readSummary(scope), /用户画像：现居上海/u)
  assert.doesNotMatch(await f.store.readSummary(scope), /用户长期居住在北京/u)
  assert.match(await f.store.readSummary(scope), /事件驱动/u)
  assert.doesNotMatch(await f.store.readIndex(scope, 2000), /project-overview/u)
  assert.match(await f.store.readIndex(scope, 2000), /architecture/u)
  const changed = await f.store.prepareSemanticSummary(scope, 86_400_000)
  assert.equal(changed.status, 'ready')
  if (changed.status !== 'ready') throw new Error('changed topic was not ready')
  assert.deepEqual(changed.dirtyTopics.map(topic => topic.id), ['project-overview'])
  await f.engine.update({ cwd, id: entry.id, content: '用户现居深圳市。', title: '现居城市', description: '用户长期居住在深圳' })
  assert.equal(await f.store.commitSemanticSummary(
    scope,
    changed,
    [{ id: 'project-overview', content: '用户画像：现居北京。', sourceIds: [entry.id] }],
    2000,
    2,
  ), false)
  assert.doesNotMatch(await f.store.readSummary(scope), /现居北京/u)
  const refreshed = await f.store.prepareSemanticSummary(scope, 86_400_000)
  assert.equal(refreshed.status, 'ready')
  if (refreshed.status !== 'ready') throw new Error('refreshed topic was not ready')
  assert.equal(await f.store.commitSemanticSummary(
    scope,
    refreshed,
    [{ id: 'project-overview', content: '用户画像：现居深圳。', sourceIds: [entry.id] }],
    2000,
    2,
  ), true)
  assert.match(await f.store.readSummary(scope), /用户画像：现居深圳/u)
  assert.match(await f.store.readSummary(scope), /事件驱动/u)
  assert.ok(Buffer.byteLength(await f.store.readSummary(scope)) <= 2000)
  assert.equal((await f.store.prepareSemanticSummary(scope, 86_400_000)).status, 'clean')
  f.advance(86_400_000)
  const periodic = await f.store.prepareSemanticSummary(scope, 86_400_000)
  assert.equal(periodic.status, 'ready')
  if (periodic.status !== 'ready') throw new Error('periodic refresh was not ready')
  assert.deepEqual(periodic.dirtyTopics.filter(topic => topic.entries.length > 0).map(topic => topic.id), ['project-overview', 'architecture'])
})

test('marks a missing semantic representation for background refresh without publishing raw entries', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-summary-repair')
  const scope = f.store.scope(cwd)
  await f.store.ensure(scope)
  await f.store.writeEntries(scope, [{ id: 'repair-entry', content: '启动扫描应恢复这条事实。', status: 'active' }])
  const repair = await f.store.repairSummary(scope, 86_400_000)
  assert.equal(repair.needsRefresh, true)
  assert.equal(await f.store.readSummary(scope), '')
})

test('does not rebuild a summary for successful checkpoints without memory mutations', async () => {
  const f = await fixture({ config: { consolidateEvery: 1 }, distilled: { version: 1, operations: [] } })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-no-summary-churn')
  await f.engine.remember({ cwd, content: '稳定事实不应被无变化 checkpoint 重写。' })
  const scope = f.store.scope(cwd)
  assert.equal((await readdir(join(scope.dir, 'summary_history'))).length, 0)
  await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u-no-change', role: 'user', text: '这轮没有新的长期事实。' }],
  })
  assert.equal((await readdir(join(scope.dir, 'summary_history'))).length, 0)
})

test('merges global and workspace memories while preserving field-aware ranking', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace')
  await f.engine.remember({ scope: 'global', cwd, content: '用户偏好使用中文回答。', title: '语言偏好', description: '默认使用中文', tags: ['preference'], importance: 2 })
  await f.engine.remember({ cwd, content: '项目使用 TypeScript。', title: '项目语言', description: '代码统一使用 TypeScript', tags: ['typescript'], type: 'architecture', retrievalTerms: ['TS'] })
  const context = await f.engine.recall({ cwd, query: 'TS 项目语言' })
  assert.equal(context.matches[0]?.title, '项目语言')
  assert.ok(context.matches.some(match => match.title === '语言偏好'))
  assert.equal(context.summary, '')
})

test('lists persisted scopes and reads an unused scope without creating it', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace')
  await f.engine.remember({ scope: 'global', content: '全局偏好。' })
  await f.engine.remember({ cwd, content: '项目事实。' })
  const scopes = await f.store.listScopes()
  assert.deepEqual(scopes.map(scope => scope.key), ['global', f.store.scope(cwd).key])
  const unused = f.store.scope(join(f.root, 'unused'))
  const snapshot = await f.store.readSnapshot(unused)
  assert.equal(snapshot.entries.length, 0)
  assert.equal(snapshot.summary, '')
  assert.equal(snapshot.state.pendingMessages.length, 0)
})

test('archives a workspace scope and permanently purges it on request', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace')
  await f.engine.remember({ cwd, content: '可恢复的项目记忆。' })
  const scope = f.store.scope(cwd)
  assert.equal((await f.store.readSnapshot(scope)).entries[0]?.content, '可恢复的项目记忆。')
  assert.equal((await f.store.archiveScope(scope)), true)
  assert.deepEqual(await f.store.listScopes(), [f.store.scope('')])
  const archived = await f.store.listArchivedScopes()
  assert.equal(archived[0]?.key, scope.key)
  assert.equal((await f.store.readArchivedSnapshot(scope)).entries[0]?.content, '可恢复的项目记忆。')
  assert.equal(await f.store.purgeArchivedScope(scope), true)
  assert.equal((await f.store.listArchivedScopes()).length, 0)
  const recreated = f.store.scope(cwd)
  const activeSnapshot = await f.store.readSnapshot(recreated)
  assert.equal(activeSnapshot.entries.length, 0)
  assert.equal(activeSnapshot.summary, '')
  const archivedSnapshot = await f.store.readArchivedSnapshot(recreated)
  assert.equal(archivedSnapshot.entries.length, 0)
  assert.equal(archivedSnapshot.summary, '')
})

test('supports legacy entries without metadata', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace')
  const scope = f.store.scope(cwd)
  await f.store.ensure(scope)
  await f.store.writeEntries(scope, [{ id: 'legacy', content: '旧版记忆内容。' }])
  const entries = await f.store.readEntries(scope)
  assert.equal(entries[0]?.type, 'fact')
  assert.equal(entries[0]?.title, '旧版记忆内容。')
})

test('accepts the legacy distiller memories object as add operations', async () => {
  const f = await fixture({ distilled: { memories: [{ content: '旧版蒸馏输出仍可写入。' }] } })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'legacy-distill')
  const result = await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u1', role: 'user', text: '保存一条兼容记忆。' }],
  })
  assert.equal(result.added, 1)
  assert.equal((await f.store.readEntries(f.store.scope(cwd)))[0]?.content, '旧版蒸馏输出仍可写入。')
})

test('retains pending messages when the operation contract is invalid and retries later', async () => {
  let fail = true
  const f = await fixture({
    distill: () => fail ? { version: 2, operations: [] } : [{ content: '重试后保存的事实。' }],
  })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'failed-distill')
  const first = await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u1', role: 'user', text: '这次蒸馏契约无效。' }],
  })
  assert.equal(first.status, 'failed')
  assert.equal((await f.store.readState(f.store.scope(cwd))).pendingMessages.length, 1)
  fail = false
  const retried = await f.engine.checkpoint({ cwd, reason: 'explicit', force: true, messages: [] })
  assert.equal(retried.status, 'committed')
  assert.equal((await f.store.readState(f.store.scope(cwd))).pendingMessages.length, 0)
})

test('budgets matches after truncating the combined summaries', async () => {
  const f = await fixture({ config: { summaryMaxBytes: 1000 } })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace')
  for (let index = 0; index < 16; index += 1) {
    await f.engine.remember({ scope: 'global', content: `全局长期偏好 ${index}：${'偏好内容'.repeat(30)}`, importance: 1 })
    await f.engine.remember({ cwd, content: `项目长期事实 ${index}：${'项目内容'.repeat(30)}`, importance: 1 })
  }
  await f.engine.remember({ cwd, content: '预算测试目标记忆：项目使用 TypeScript。', title: '预算测试目标', importance: 3 })
  const context = await f.engine.recall({ cwd, query: '预算测试目标 TypeScript', maxBytes: 1500 })
  assert.equal(context.summary, '')
  assert.equal(context.matches[0]?.title, '预算测试目标')
})

test('revises a near-duplicate with shorter content and retains the previous version', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-revision')
  await f.engine.remember({ cwd, content: '项目使用 PostgreSQL 数据库。' })
  const result = await f.engine.remember({ cwd, content: '项目使用 PostgreSQL。' })
  assert.equal(result.updated, 1)
  const entries = await f.store.readEntries(f.store.scope(cwd))
  assert.equal(entries[0]?.content, '项目使用 PostgreSQL。')
  assert.equal(entries[0]?.revisions?.[0]?.content, '项目使用 PostgreSQL 数据库。')
})

test('manually edits and deletes a memory while invalidating stale semantic content', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-manual-edit')
  await f.engine.remember({ cwd, content: '项目数据库使用 MySQL。', title: '数据库', tags: ['mysql'], importance: 2 })
  const scope = f.store.scope(cwd)
  const id = (await f.store.readEntries(scope))[0]?.id
  assert.ok(id)

  const updated = await f.engine.update({
    cwd,
    id,
    content: '项目数据库使用 PostgreSQL。',
    title: '数据库选型',
    description: '当前项目数据库',
    tags: ['postgresql'],
    type: 'architecture',
    importance: 3,
  })
  assert.equal(updated.updated, true)
  const edited = (await f.store.readEntries(scope))[0]
  assert.equal(edited?.content, '项目数据库使用 PostgreSQL。')
  assert.equal(edited?.revisions?.[0]?.content, '项目数据库使用 MySQL。')
  assert.equal(edited?.provenance?.reason, 'manual')
  const recalled = await f.engine.recall({ cwd, query: 'PostgreSQL' })
  assert.equal(recalled.matches[0]?.content, '项目数据库使用 PostgreSQL。')
  assert.equal(recalled.summary, '')
  assert.doesNotMatch(recalled.summary, /MySQL/u)

  const deleted = await f.engine.forget({ cwd, id })
  assert.equal(deleted.deleted, true)
  assert.equal((await f.engine.recall({ cwd, query: 'PostgreSQL' })).matches.length, 0)
  assert.doesNotMatch((await f.store.readSnapshot(scope)).summary, /数据库选型/u)
})

test('deleting one conflicting memory restores the remaining fact to active recall', async () => {
  const f = await fixture()
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-conflict-delete')
  const scope = f.store.scope(cwd)
  await f.store.ensure(scope)
  await f.store.writeEntries(scope, [
    { id: 'wrong', content: '项目使用 MySQL。', title: '数据库', status: 'conflict', conflictGroupId: 'database-conflict' },
    { id: 'correct', content: '项目使用 PostgreSQL。', title: '数据库', status: 'conflict', conflictGroupId: 'database-conflict' },
  ])

  assert.equal((await f.engine.forget({ cwd, id: 'wrong' })).deleted, true)
  const entries = await f.store.readEntries(scope)
  assert.equal(entries.find(entry => entry.id === 'correct')?.status, 'active')
  assert.equal(entries.find(entry => entry.id === 'correct')?.conflictGroupId, undefined)
  assert.equal((await f.engine.recall({ cwd, query: 'PostgreSQL' })).matches[0]?.id, 'correct')
})

test('supersedes an explicitly corrected memory and immediately removes it from recall and summary', async () => {
  const f = await fixture({
    config: { consolidateEvery: 5 },
    distill: input => {
      const target = input.existingEntries?.find(entry => entry.content.includes('MySQL'))
      return {
        version: 1,
        operations: [{
          op: 'supersede',
          targetId: target?.id,
          targetScope: 'workspace',
          scope: 'workspace',
          content: '项目数据库使用 PostgreSQL。',
          evidenceMessageIds: ['u-correction'],
          newQuote: '项目实际使用 PostgreSQL',
          oldQuote: 'MySQL',
        }],
      }
    },
  })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-correction')
  await f.engine.remember({ cwd, content: '项目数据库使用 MySQL。' })
  const result = await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u-correction', role: 'user', text: '前面说错了，项目实际使用 PostgreSQL。' }],
  })
  assert.equal(result.superseded, 1)
  const scope = f.store.scope(cwd)
  const entries = await f.store.readEntries(scope)
  assert.equal(entries.find(entry => entry.content.includes('MySQL'))?.status, 'superseded')
  assert.equal(entries.find(entry => entry.content.includes('PostgreSQL'))?.status, 'active')
  assert.doesNotMatch(await f.store.readSummary(scope), /MySQL/u)
  assert.equal(await f.store.readSummary(scope), '')
  assert.equal((await f.engine.recall({ cwd, query: 'MySQL 数据库' })).matches.some(match => match.content.includes('MySQL')), false)
})

test('rejects supersede without verbatim user evidence and audits the rejection', async () => {
  const f = await fixture({
    distill: input => ({
      version: 1,
      operations: [{
        op: 'supersede',
        targetId: input.existingEntries?.find(entry => entry.content.includes('MySQL'))?.id,
        content: '项目数据库使用 PostgreSQL。',
        evidenceMessageIds: ['a1'],
        newQuote: 'PostgreSQL',
        oldQuote: 'MySQL',
      }],
    }),
  })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-rejected')
  await f.engine.remember({ cwd, content: '项目数据库使用 MySQL。' })
  const result = await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [
      { id: 'u1', role: 'user', text: '请检查项目数据库配置。' },
      { id: 'a1', role: 'assistant', text: '项目数据库使用 PostgreSQL。' },
    ],
  })
  assert.equal(result.ignored, 1)
  const scope = f.store.scope(cwd)
  assert.equal((await f.store.readEntries(scope)).find(entry => entry.content.includes('MySQL'))?.status, 'active')
  const checkpoint = (await readdir(join(scope.dir, 'checkpoints')))[0]
  assert.ok(checkpoint)
  const markdown = await readFile(join(scope.dir, 'checkpoints', checkpoint), 'utf8')
  assert.match(markdown, /rejected: supersede/u)
  assert.match(markdown, /user evidence/u)
})

test('keeps uncertain corrections as an explicit conflict and excludes the group from summary', async () => {
  const f = await fixture({
    distill: input => ({
      version: 1,
      operations: [{
        op: 'flag-conflict',
        targetId: input.existingEntries?.find(entry => entry.content.includes('MySQL'))?.id,
        content: '项目数据库可能使用 PostgreSQL。',
        tags: ['database'],
      }],
    }),
  })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-conflict')
  await f.engine.remember({ cwd, content: '项目数据库使用 MySQL。', tags: ['database'] })
  const result = await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [
      { id: 'u1', role: 'user', text: '请检查项目数据库配置。' },
      { id: 'a1', role: 'assistant', text: '代码看起来可能使用 PostgreSQL。' },
    ],
  })
  assert.equal(result.conflicts, 1)
  const scope = f.store.scope(cwd)
  const entries = await f.store.readEntries(scope)
  assert.equal(entries.filter(entry => entry.status === 'conflict').length, 2)
  assert.equal(new Set(entries.map(entry => entry.conflictGroupId).filter(Boolean)).size, 1)
  assert.doesNotMatch(await f.store.readSummary(scope), /MySQL|PostgreSQL/u)
  const matches = (await f.engine.recall({ cwd, query: '项目数据库' })).matches
  assert.equal(matches.length, 2)
  assert.ok(matches.every(match => match.status === 'conflict' && match.conflictWith?.length === 1))
})

test('an explicit correction supersedes only the named member of a conflict group', async () => {
  const f = await fixture({
    distill: input => {
      const target = input.existingEntries?.find(entry => entry.content.includes('MySQL'))
      const resolving = input.messages.some(message => message.id === 'u-resolve')
      return resolving
        ? {
            version: 1,
            operations: [{
              op: 'supersede',
              targetId: target?.id,
              content: '项目数据库使用 SQLite。',
              evidenceMessageIds: ['u-resolve'],
              newQuote: '实际使用 SQLite',
              oldQuote: 'MySQL',
            }],
          }
        : { version: 1, operations: [{ op: 'flag-conflict', targetId: target?.id, content: '项目数据库可能使用 PostgreSQL。' }] }
    },
  })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-resolve-conflict')
  await f.engine.remember({ cwd, content: '项目数据库使用 MySQL。' })
  await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [
      { id: 'u-conflict', role: 'user', text: '请检查项目数据库配置。' },
      { id: 'a-conflict', role: 'assistant', text: '项目数据库可能使用 PostgreSQL。' },
    ],
  })
  const result = await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u-resolve', role: 'user', text: 'MySQL 这个说法不对，项目实际使用 SQLite。' }],
  })
  assert.equal(result.superseded, 1)
  const entries = await f.store.readEntries(f.store.scope(cwd))
  assert.equal(entries.filter(entry => entry.status === 'superseded').length, 1)
  assert.equal(entries.filter(entry => entry.status === 'conflict').length, 1)
  const active = entries.filter(entry => entry.status === 'active')
  assert.equal(active.length, 1)
  assert.match(active[0]?.content ?? '', /SQLite/u)
  assert.equal(active[0]?.supersedes?.length, 1)
})

test('routes a workspace correction to global memory and rebuilds the global summary', async () => {
  const f = await fixture({
    distill: input => ({
      version: 1,
      operations: [{
        op: 'supersede',
        targetId: input.existingEntries?.find(entry => entry.scope === 'global' && entry.content.includes('创建文件'))?.id,
        targetScope: 'global',
        scope: 'global',
        content: '联网搜索时不要创建文件。',
        evidenceMessageIds: ['u-global'],
        newQuote: '联网搜索时不要创建文件',
        oldQuote: '创建文件',
      }],
    }),
  })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-global-correction')
  await f.engine.remember({ scope: 'global', content: '联网搜索时需要创建文件。' })
  const result = await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u-global', role: 'user', text: '更正：联网搜索时不要创建文件。' }],
  })
  assert.equal(result.superseded, 1)
  assert.ok(f.calls[0]?.existingEntries?.some(entry => entry.scope === 'global'))
  const global = f.store.scope('')
  const entries = await f.store.readEntries(global)
  assert.equal(entries.find(entry => entry.content.includes('需要创建'))?.status, 'superseded')
  assert.equal(await f.store.readSummary(global), '')
  assert.doesNotMatch(await f.store.readSummary(global), /需要创建文件/u)
})

test('downgrades a correction against a branched supersede chain into one conflict group', async () => {
  const f = await fixture({
    distilled: {
      version: 1,
      operations: [{ op: 'supersede', targetId: 'old', content: '项目数据库使用 SQLite。' }],
    },
  })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-branch')
  const scope = f.store.scope(cwd)
  await f.store.ensure(scope)
  await f.store.writeEntries(scope, [
    { id: 'old', content: '项目数据库使用 MySQL。', status: 'superseded', supersededBy: ['branch-a', 'branch-b'] },
    { id: 'branch-a', content: '项目数据库使用 PostgreSQL。', status: 'active' },
    { id: 'branch-b', content: '项目数据库使用 MariaDB。', status: 'active' },
  ])
  const result = await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u1', role: 'user', text: '项目数据库使用 SQLite。' }],
  })
  assert.equal(result.conflicts, 1)
  const entries = await f.store.readEntries(scope)
  const conflicts = entries.filter(entry => entry.status === 'conflict')
  assert.equal(conflicts.length, 3)
  assert.equal(new Set(conflicts.map(entry => entry.conflictGroupId)).size, 1)
  assert.equal(entries.find(entry => entry.id === 'old')?.status, 'superseded')
})

test('redirects a second correction through a unique supersede chain head', async () => {
  let originalId = ''
  const f = await fixture({
    distill: input => {
      const second = input.messages.some(message => message.id === 'u-second')
      return {
        version: 1,
        operations: [{
          op: 'supersede',
          targetId: second ? originalId : input.existingEntries?.find(entry => entry.content.includes('MySQL'))?.id,
          content: second ? '项目数据库使用 SQLite。' : '项目数据库使用 PostgreSQL。',
          evidenceMessageIds: [second ? 'u-second' : 'u-first'],
          newQuote: second ? '实际使用 SQLite' : '实际使用 PostgreSQL',
          oldQuote: second ? 'PostgreSQL' : 'MySQL',
        }],
      }
    },
  })
  onTestFinished(f.cleanup)
  const cwd = join(f.root, 'workspace-chain')
  await f.engine.remember({ cwd, content: '项目数据库使用 MySQL。' })
  originalId = (await f.store.readEntries(f.store.scope(cwd)))[0]?.id ?? ''
  await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u-first', role: 'user', text: '更正，项目实际使用 PostgreSQL。' }],
  })
  const second = await f.engine.checkpoint({
    cwd,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u-second', role: 'user', text: '再次更正，项目实际使用 SQLite。' }],
  })
  assert.equal(second.superseded, 1)
  const entries = await f.store.readEntries(f.store.scope(cwd))
  assert.equal(entries.find(entry => entry.content.includes('PostgreSQL'))?.status, 'superseded')
  assert.equal(entries.find(entry => entry.content.includes('SQLite'))?.status, 'active')
  assert.deepEqual(entries.find(entry => entry.id === originalId)?.supersededBy?.length, 1)
})
