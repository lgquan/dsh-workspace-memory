import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { onTestFinished, test } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { agentCarrier, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkspaceMemoryStore } from '../src/core.ts'
import WorkspaceMemoryRuntime from '../src/index.ts'

class MemoryAdapter extends LlmAdapter {
  async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield {
      type: 'text-delta',
      index: 0,
      text: '{"version":1,"operations":[{"op":"add","content":"Voco 前台通过可选 workspaceMemory 接口读取长期记忆。","tags":["voice","architecture"],"importance":3}]}',
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class SequenceMemoryAdapter extends LlmAdapter {
  private index = 0

  constructor(private readonly outputs: readonly string[]) {
    super()
  }

  async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const output = this.outputs[Math.min(this.index++, this.outputs.length - 1)] ?? '{}'
    yield { type: 'text-delta', index: 0, text: output }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class CapturingMemoryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(options)
    yield {
      type: 'text-delta',
      index: 0,
      text: '{"version":1,"operations":[{"op":"add","content":"新版会话事件能够触发记忆整理。","tags":["compatibility"],"importance":2}]}',
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ReasoningMemoryAdapter extends CapturingMemoryAdapter {
  constructor(private readonly efforts?: readonly string[]) {
    super()
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const info = await super.resolveModel(provider, model)
    if (this.efforts === undefined) return info
    return {
      ...info,
      reasoning: {
        efforts: this.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId(this.efforts.at(-1) ?? ''),
      },
    }
  }
}

class BlockingMemoryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  active = 0
  maxActive = 0
  private releaseGate!: () => void
  private readonly gate = new Promise<void>(resolve => { this.releaseGate = resolve })

  release(): void {
    this.releaseGate()
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(options)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      await this.gate
      yield { type: 'text-delta', index: 0, text: '{"version":1,"operations":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      this.active -= 1
    }
  }
}

class CatalogMemoryAdapter extends MemoryAdapter {
  override async listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return [{ provider, id: 'deepseek-flash', name: 'DeepSeek Flash' }]
  }
}

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void> | void

class FakeWebServer extends Service {
  readonly routes = new Map<string, RouteHandler>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(route: { path: string; handler: RouteHandler }): () => void {
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }
}

class FakeWorkspaceRegistry extends Service {
  constructor(ctx: Context, private readonly workspaces: Array<{ id: string; path: string; title: string }>) {
    super(ctx, 'workspaceRegistry')
  }

  list(): Array<{ id: string; path: string; title: string }> {
    return this.workspaces
  }
}

class FakeSettings extends Service {
  readonly writes: Array<{ ns: string; patch: object }> = []

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  get writable(): boolean {
    return true
  }

  configure(): () => void {
    return () => {}
  }

  async update(ns: string, patch: object): Promise<void> {
    this.writes.push({ ns, patch })
  }
}

async function requestJson(handler: RouteHandler, url: string, method = 'GET', requestBody?: unknown): Promise<{ status: number; body: unknown }> {
  let status = 200
  let body = ''
  const source = requestBody === undefined ? [] : [JSON.stringify(requestBody)]
  const request = Object.assign(Readable.from(source), { method, url }) as IncomingMessage
  const response = {
    statusCode: 200,
    setHeader: () => {},
    end: (value?: string) => { body = value ?? ''; status = response.statusCode },
  } as unknown as ServerResponse & { statusCode: number }
  await handler(request, response)
  return { status, body: JSON.parse(body) as unknown }
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

test('Cordis adapter distils, stores, recalls, and registers explicit tools', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-runtime-'))
  const workspace = join(memoryDir, 'project')
  const ctx = new Context()
  onTestFinished(async () => {
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], new MemoryAdapter())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    checkpointTurns: 1,
    consolidateEvery: 1,
    summarizeProvider: 'test',
    summarizeModel: 'test',
  })
  await new Promise(resolve => setImmediate(resolve))

  const session = ctx.sessions.create(SessionId('memory-runtime-test'), { meta: { cwd: workspace } })
  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  const checkpoint = await memory.checkpoint({
    sessionId: session.id,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'user-1', role: 'user', text: '请记住 Voco 使用可选接口读取记忆。' }],
  })
  assert.equal(checkpoint.status, 'committed', JSON.stringify(checkpoint))

  const childOne = ctx.sessions.create(SessionId('memory-voice-child-1'), {
    meta: { cwd: workspace, parentSession: session.id, origin: 'subagent' },
  })
  const childTwo = ctx.sessions.create(SessionId('memory-voice-child-2'), {
    meta: { cwd: workspace, parentSession: session.id, origin: 'subagent' },
  })
  const childOneCheckpoint = await memory.checkpoint({
    sessionId: childOne.id,
    reason: 'task-end',
    messages: [
      { id: 'voice-child-1-request', role: 'user', text: '检查第一个委派任务。' },
      { id: 'voice-child-1-result', role: 'assistant', text: '第一个委派任务已经完成。' },
    ],
  })
  const childTwoCheckpoint = await memory.checkpoint({
    sessionId: childTwo.id,
    reason: 'task-end',
    messages: [
      { id: 'voice-child-2-request', role: 'user', text: '检查第二个委派任务。' },
      { id: 'voice-child-2-result', role: 'assistant', text: '第二个委派任务已经完成。' },
    ],
  })
  assert.equal(childOneCheckpoint.status, 'committed', JSON.stringify(childOneCheckpoint))
  assert.equal(childTwoCheckpoint.status, 'committed', JSON.stringify(childTwoCheckpoint))
  assert.equal(childOneCheckpoint.scope, checkpoint.scope)
  assert.equal(childTwoCheckpoint.scope, checkpoint.scope)
  assert.equal(childOneCheckpoint.accepted, 2)
  assert.equal(childTwoCheckpoint.accepted, 2)

  const recalled = await memory.recall({ sessionId: session.id, query: 'Voco 可选接口' })
  assert.equal(recalled.matches[0]?.content, 'Voco 前台通过可选 workspaceMemory 接口读取长期记忆。')
  assert.match(recalled.summary, /workspaceMemory/u)
  const agent = { session } as Agent
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
  assert.match(assembly.contexts.find(item => item.name === 'workspace-memory-summary')?.text ?? '', /workspaceMemory/u)
  await ctx.plugin(ToolRuntime)
  await flushAsyncWork()
  assert.ok(ctx.tools.get('memory_search'))
  assert.ok(ctx.tools.get('memory_remember'))
  assert.ok(ctx.tools.get('memory_forget'))
})

test('recovers an overdue pending scope when the runtime starts', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-recovery-'))
  const workspace = join(memoryDir, 'project')
  onTestFinished(async () => {
    await rm(memoryDir, { recursive: true, force: true })
  })
  const seedStore = new WorkspaceMemoryStore(memoryDir)
  const scope = seedStore.scope(workspace)
  await seedStore.ensure(scope)
  const state = await seedStore.readState(scope)
  state.pendingMessages = [{ id: 'recovered-user', role: 'user', text: '服务启动后应自动整理这条消息。' }]
  state.lastBufferedAt = Date.now() - 10_000
  await seedStore.writeState(scope, state)

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], new MemoryAdapter())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    checkpointTurns: 10,
    checkpointChars: 4000,
    idleCheckpointMs: 1000,
    summarizeProvider: 'test',
    summarizeModel: 'test',
  })
  await flushAsyncWork()
  const session = ctx.sessions.create(SessionId('recovery-runtime-test'), { meta: { cwd: workspace } })
  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  await new Promise(resolve => setTimeout(resolve, 50))
  await flushAsyncWork()
  assert.equal((await seedStore.readState(scope)).pendingMessages.length, 0)
  const recovered = await memory.recall({ sessionId: session.id, query: 'Voco 可选接口' })
  assert.match(recovered.summary, /workspaceMemory/u)
})

test('retries a failed checkpoint automatically', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-retry-'))
  const workspace = join(memoryDir, 'project')
  onTestFinished(async () => {
    await rm(memoryDir, { recursive: true, force: true })
  })
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], new SequenceMemoryAdapter([
    'not valid json',
    '{"version":1,"operations":[{"op":"add","content":"重试成功后写入的事实。"}]}',
  ]))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    checkpointTurns: 1,
    idleCheckpointMs: 1000,
    summarizeProvider: 'test',
    summarizeModel: 'test',
  })
  await flushAsyncWork()
  const session = ctx.sessions.create(SessionId('retry-runtime-test'), { meta: { cwd: workspace } })
  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  const first = await memory.checkpoint({
    sessionId: session.id,
    reason: 'segment-end',
    messages: [{ id: 'retry-user', role: 'user', text: '第一次蒸馏会失败。' }],
  })
  assert.equal(first.status, 'failed', JSON.stringify(first))
  await new Promise(resolve => setTimeout(resolve, 1200))
  await flushAsyncWork()
  const state = await new WorkspaceMemoryStore(memoryDir).readState(new WorkspaceMemoryStore(memoryDir).scope(workspace))
  assert.equal(state.pendingMessages.length, 0)
})

test('queues derived DSH 0.2.2 messages without re-distilling recalled memory', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-events-'))
  const workspace = join(memoryDir, 'project')
  const ctx = new Context()
  const adapter = new CapturingMemoryAdapter()
  onTestFinished(async () => {
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], adapter)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    checkpointTurns: 1,
    consolidateEvery: 1,
    processingDelayMs: 10,
    summarizeProvider: 'test',
    summarizeModel: 'test',
  })
  await flushAsyncWork()

  const session = ctx.sessions.create(SessionId('memory-runtime-events'), { meta: { cwd: workspace } })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '这段召回内容不能再次进入蒸馏。' }],
    source: { kind: 'workspace-memory' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '请记住新版会话事件已经兼容。' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  const agent = { session } as Agent
  ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  for (let attempt = 0; attempt < 20 && adapter.requests.length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  assert.equal(adapter.requests.length, 1)
  const requestText = adapter.requests[0]!.messages
    .flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
  assert.match(requestText, /请记住新版会话事件已经兼容/u)
  assert.doesNotMatch(requestText, /这段召回内容不能再次进入蒸馏/u)
  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  const recalled = await memory.recall({ sessionId: session.id, query: '新版会话事件' })
  assert.equal(recalled.matches[0]?.content, '新版会话事件能够触发记忆整理。')
})

test('resolves a persisted DSH 0.2.2 session workspace through stat()', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-persisted-'))
  const workspace = join(memoryDir, 'persisted-project')
  let statCalls = 0
  class FakeSessionPersistence extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'sessionPersistence') }
    async stat(): Promise<{ header: { cwd: string } }> {
      statCalls += 1
      return { header: { cwd: workspace } }
    }
  }

  const ctx = new Context()
  onTestFinished(async () => {
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(FakeSessionPersistence)
  await ctx.plugin(WorkspaceMemoryRuntime, { memoryDir })
  await flushAsyncWork()

  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  const sessionId = SessionId('persisted-memory-runtime-test')
  const stored = await memory.remember({ sessionId, content: '持久化会话仍然写入原项目记忆。' })
  assert.equal(stored.scope, new WorkspaceMemoryStore(memoryDir).scope(workspace).key)
  assert.equal(stored.added, 1)
  assert.equal(statCalls, 1)
})

test('uses the configured fixed memory model', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-model-'))
  const ctx = new Context()
  const adapter = new CapturingMemoryAdapter()
  onTestFinished(async () => {
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['foreground', 'memory-provider'], adapter)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    summarizeProvider: 'memory-provider',
    summarizeModel: 'memory-model',
  })
  await flushAsyncWork()

  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  const result = await memory.checkpoint({
    cwd: join(memoryDir, 'project'),
    reason: 'explicit',
    messages: [{ id: 'fixed-model-user', role: 'user', text: '固定模型负责整理。' }],
  })
  assert.equal(result.status, 'committed')
  assert.equal(adapter.requests[0]?.provider, 'memory-provider')
  assert.equal(adapter.requests[0]?.model, 'memory-model')
})

test('selects the least reasoning effort supported by the memory model', async () => {
  const cases = [
    { name: 'prefers off when available', efforts: ['off', 'low', 'high'], expected: 'off' },
    { name: 'uses the advertised minimum without off', efforts: ['low', 'high'], expected: 'low' },
    { name: 'omits reasoning for models without reasoning metadata', efforts: undefined, expected: undefined },
  ] as const

  for (const current of cases) {
    const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-reasoning-'))
    const ctx = new Context()
    const adapter = new ReasoningMemoryAdapter(current.efforts)
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['memory-provider'], adapter)
      await ctx.plugin(WorkspaceMemoryRuntime, {
        memoryDir,
        summarizeProvider: 'memory-provider',
        summarizeModel: 'memory-model',
      })
      await flushAsyncWork()

      const memory = ctx.get('workspaceMemory')
      assert.ok(memory)
      const result = await memory.checkpoint({
        cwd: join(memoryDir, 'project'),
        reason: 'explicit',
        messages: [{ id: `reasoning-${current.name}`, role: 'user', text: '整理任务使用最低推理档。' }],
      })
      assert.equal(result.status, 'committed', current.name)
      assert.equal(adapter.requests[0]?.reasoningEffort, current.expected, current.name)
    } finally {
      await ctx.fiber.dispose()
      await rm(memoryDir, { recursive: true, force: true })
    }
  }
})

test('refreshes pending memory before a new session first recalls the workspace', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-freshness-'))
  const workspace = join(memoryDir, 'project')
  const ctx = new Context()
  const adapter = new CapturingMemoryAdapter()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], adapter)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    processingDelayMs: 60_000,
    summarizeProvider: 'test',
    summarizeModel: 'test',
  })
  await flushAsyncWork()

  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  const buffered = await memory.checkpoint({
    cwd: workspace,
    reason: 'segment-end',
    defer: true,
    messages: [{ id: 'freshness-user', role: 'user', text: '请记住新版会话事件已经兼容。' }],
  })
  assert.equal(buffered.pending, 1)
  assert.equal(adapter.requests.length, 0)

  const session = ctx.sessions.create(SessionId('memory-freshness-new-session'), { meta: { cwd: workspace } })
  const agent = { session } as Agent
  const query = createUserMessage({
    content: [{ type: 'text', text: '新版会话事件是否兼容？' }],
    source: { kind: 'user' },
  })
  const decision = await ctx.waterfall(agentCarrier(agent), 'agent/pre-step', {
    agent,
    messages: [query],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    modelSelection: { provider: 'foreground', model: 'foreground' },
  }, async () => ({ kind: 'enter' as const, messages: [] }))

  assert.equal(adapter.requests.length, 1)
  const state = await new WorkspaceMemoryStore(memoryDir).readState(new WorkspaceMemoryStore(memoryDir).scope(workspace))
  assert.equal(state.pendingMessages.length, 0)
  assert.equal(decision.kind, 'enter')
  const recalledText = decision.kind === 'enter'
    ? decision.messages.at(-1)?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    : ''
  assert.match(recalledText, /新版会话事件能够触发记忆整理/u)
})

test('continues first recall with existing memory when pending refresh exceeds ten seconds', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-freshness-timeout-'))
  const workspace = join(memoryDir, 'project')
  const ctx = new Context()
  const adapter = new BlockingMemoryAdapter()
  onTestFinished(async () => {
    adapter.release()
    await new Promise(resolve => setTimeout(resolve, 20))
    await ctx.fiber.dispose()
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], adapter)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    processingDelayMs: 60_000,
    summarizeProvider: 'test',
    summarizeModel: 'test',
  })
  await flushAsyncWork()

  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  const runtime = memory as unknown as { freshnessWaitMs: number }
  runtime.freshnessWaitMs = 10
  await memory.remember({ cwd: workspace, content: '已有记忆在整理超时时仍然可以召回。', tags: ['超时'] })
  await memory.checkpoint({
    cwd: workspace,
    reason: 'segment-end',
    defer: true,
    messages: [{ id: 'freshness-timeout-user', role: 'user', text: '这条新内容的整理会被阻塞。' }],
  })

  const session = ctx.sessions.create(SessionId('memory-freshness-timeout-session'), { meta: { cwd: workspace } })
  const agent = { session } as Agent
  const query = createUserMessage({
    content: [{ type: 'text', text: '整理超时时已有记忆还能召回吗？' }],
    source: { kind: 'user' },
  })
  const decisionPromise = ctx.waterfall(agentCarrier(agent), 'agent/pre-step', {
    agent,
    messages: [query],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    modelSelection: { provider: 'foreground', model: 'foreground' },
  }, async () => ({ kind: 'enter' as const, messages: [] }))
  for (let attempt = 0; attempt < 20 && adapter.requests.length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.equal(adapter.requests.length, 1)

  const decision = await decisionPromise
  const recalledText = decision.kind === 'enter'
    ? decision.messages.at(-1)?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    : ''
  assert.match(recalledText, /已有记忆在整理超时时仍然可以召回/u)
  adapter.release()
  await memory.checkpoint({ cwd: workspace, messages: [], reason: 'idle' })
})

test('limits concurrent memory distillations across workspaces', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-concurrency-'))
  const ctx = new Context()
  const adapter = new BlockingMemoryAdapter()
  onTestFinished(async () => {
    adapter.release()
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], adapter)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    maxConcurrentDistillations: 1,
    summarizeProvider: 'test',
    summarizeModel: 'test',
  })
  await flushAsyncWork()

  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  const first = memory.checkpoint({
    cwd: join(memoryDir, 'project-a'),
    reason: 'explicit',
    messages: [{ id: 'concurrent-a', role: 'user', text: '项目 A。' }],
  })
  const second = memory.checkpoint({
    cwd: join(memoryDir, 'project-b'),
    reason: 'explicit',
    messages: [{ id: 'concurrent-b', role: 'user', text: '项目 B。' }],
  })
  for (let attempt = 0; attempt < 20 && adapter.requests.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(adapter.requests.length, 1)
  assert.equal(adapter.active, 1)
  adapter.release()
  const results = await Promise.all([first, second])
  assert.deepEqual(results.map(result => result.status), ['committed', 'committed'])
  assert.equal(adapter.requests.length, 2)
  assert.equal(adapter.maxActive, 1)
})

test('browser API exposes Host workspace titles and the routable model catalog', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-browser-api-'))
  const workspace = join(memoryDir, 'same-folder')
  const store = new WorkspaceMemoryStore(memoryDir)
  const scope = store.scope(workspace)
  await store.ensure(scope)
  await store.writeEntries(scope, [{
    id: 'manual-entry',
    content: '项目使用 MySQL。',
    title: '数据库',
    description: '旧数据库选型',
    tags: ['mysql'],
    type: 'architecture',
    importance: 2,
    status: 'active',
  }])
  await store.rebuildSummary(scope, await store.readEntries(scope), 3000)
  const ctx = new Context()
  onTestFinished(async () => {
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['deepseek-account'], new CatalogMemoryAdapter())
  await ctx.plugin(FakeWebServer)
  await ctx.plugin(FakeWorkspaceRegistry, [{ id: 'workspace-1', path: workspace, title: 'Renamed Project' }])
  await ctx.plugin(FakeSettings)
  const memoryFiber = await ctx.plugin(WorkspaceMemoryRuntime, { memoryDir })
  memoryFiber.entry = {
    id: 'include:workspace-memory',
    options: { id: 'workspace-memory' },
  } as NonNullable<typeof memoryFiber.entry>
  await flushAsyncWork()

  const webServer = ctx.get('webServer') as unknown as FakeWebServer
  const scopesHandler = webServer.routes.get('/workspace-memory/api/v1/scopes')
  const settingsHandler = webServer.routes.get('/workspace-memory/api/v1/settings')
  const entryHandler = webServer.routes.get('/workspace-memory/api/v1/entry')
  assert.ok(scopesHandler)
  assert.ok(settingsHandler)
  assert.ok(entryHandler)

  const scopesResponse = await requestJson(scopesHandler, '/workspace-memory/api/v1/scopes')
  assert.equal(scopesResponse.status, 200)
  const scopes = scopesResponse.body as { scopes: Array<{ cwd: string; title?: string }> }
  assert.ok(scopes.scopes.some(scope => scope.title === 'Renamed Project'))

  const settingsResponse = await requestJson(settingsHandler, '/workspace-memory/api/v1/settings')
  assert.equal(settingsResponse.status, 200)
  const settings = settingsResponse.body as { selection: { provider: string; model: string }; catalog: { groups: Array<{ id: string; models: Array<{ id: string }> }> } }
  assert.deepEqual(settings.selection, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(settings.catalog.groups[0]?.id, 'deepseek-account')
  assert.equal(settings.catalog.groups[0]?.models[0]?.id, 'deepseek-flash')

  const saveSettingsResponse = await requestJson(settingsHandler, '/workspace-memory/api/v1/settings', 'PUT', {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  assert.equal(saveSettingsResponse.status, 200)
  const settingsService = ctx.get('settings') as unknown as FakeSettings
  assert.deepEqual(settingsService.writes, [{
    ns: 'workspace-memory',
    patch: { summarizeProvider: 'deepseek-account', summarizeModel: 'deepseek-flash' },
  }])

  const entryUrl = `/workspace-memory/api/v1/entry?cwd=${encodeURIComponent(workspace)}&id=manual-entry`
  const updateResponse = await requestJson(entryHandler, entryUrl, 'PUT', {
    title: '数据库选型',
    description: '已人工修正',
    content: '项目使用 PostgreSQL。',
    tags: ['postgresql'],
    type: 'architecture',
    importance: 3,
  })
  assert.equal(updateResponse.status, 200)
  const editedEntry = (await store.readEntries(scope))[0]
  assert.equal(editedEntry?.content, '项目使用 PostgreSQL。')
  assert.equal(editedEntry?.revisions?.[0]?.content, '项目使用 MySQL。')
  const editedSnapshot = await new WorkspaceMemoryStore(memoryDir).readSnapshot(scope)
  assert.match(editedSnapshot.summary, /数据库选型/u)
  assert.doesNotMatch(editedSnapshot.summary, /MySQL/u)

  const deleteResponse = await requestJson(entryHandler, entryUrl, 'DELETE')
  assert.equal(deleteResponse.status, 200)
  const deletedSnapshot = await new WorkspaceMemoryStore(memoryDir).readSnapshot(scope)
  assert.equal(deletedSnapshot.entries[0]?.status, 'deleted')
  assert.doesNotMatch(deletedSnapshot.summary, /数据库选型/u)
})
