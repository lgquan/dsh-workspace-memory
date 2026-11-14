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
import { WorkspaceMemoryStore, type MemoryContext } from '../src/core.ts'
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
  readonly requests: GenerateOptions[] = []
  private index = 0

  constructor(private readonly outputs: readonly string[]) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(options)
    const output = this.outputs[Math.min(this.index++, this.outputs.length - 1)] ?? '{}'
    yield { type: 'text-delta', index: 0, text: output }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class MaxTokenMemoryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'text-delta', index: 0, text: '{"version":1,"operations":[{"op":"add","content":"截断' }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 1500, totalTokens: 1600 } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    const requestText = options.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const content = requestText.includes('项目使用 PostgreSQL') ? '项目使用 PostgreSQL。' : '部署目标为 Linux。'
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ version: 1, operations: [{ op: 'add', type: 'fact', content }] }) }
    yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 } }
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

class HybridMemoryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(options)
    const requestText = options.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (requestText.includes('<dirty_topics>')) {
      yield {
        type: 'text-delta',
        index: 0,
        text: '{"topics":[{"id":"project-overview","content":"用户画像：现居上海。"}]}',
      }
      yield { type: 'usage', usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield {
      type: 'text-delta',
      index: 0,
      text: JSON.stringify({ version: 1, operations: [{ op: 'add', type: 'fact', title: '现居城市', description: '用户现居上海', content: '用户现居上海市。' }] }),
    }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 } }
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
    await ctx.fiber.dispose()
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
  assert.equal(recalled.summary, '')
  const agent = { session } as Agent
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
  assert.equal(assembly.contexts.find(item => item.name === 'workspace-memory-summary')?.text ?? '', '')
  await ctx.plugin(ToolRuntime)
  await flushAsyncWork()
  assert.ok(ctx.tools.get('memory_search'))
  assert.ok(ctx.tools.get('memory_read_topic'))
  assert.ok(ctx.tools.get('memory_remember'))
  assert.ok(ctx.tools.get('memory_forget'))
})

test('Agent tools revise a global user profile without creating a workspace duplicate', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-global-profile-tools-'))
  const workspace = join(memoryDir, 'project')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(WorkspaceMemoryRuntime, { memoryDir })
  await ctx.plugin(ToolRuntime)
  await flushAsyncWork()

  const session = ctx.sessions.create(SessionId('global-profile-tool-test'), { meta: { cwd: workspace } })
  const searchTool = ctx.tools.get('memory_search')
  const rememberTool = ctx.tools.get('memory_remember')
  const updateTool = ctx.tools.get('memory_update')
  assert.ok(searchTool)
  assert.ok(rememberTool)
  assert.ok(updateTool)
  const rememberSchema = ctx.tools.schemas().find(tool => tool.name === 'memory_remember')?.parameters as {
    required?: string[]
    properties?: { scope?: { enum?: string[] } }
  }
  assert.ok(rememberSchema.required?.includes('scope'))
  assert.deepEqual(rememberSchema.properties?.scope?.enum, ['global', 'workspace'])

  const agent = { session } as Agent
  const remembered = await rememberTool.execute({
    scope: 'workspace',
    content: '用户现居上海市，尚未提供具体区。',
    type: 'fact',
    title: '用户居住地',
    description: '用户现居上海市',
    tags: ['用户信息', '居住地'],
    importance: 2,
  }, { agent } as never) as { scope: string; added: number }
  assert.equal(remembered.scope, 'global')
  assert.equal(remembered.added, 1)

  const store = new WorkspaceMemoryStore(memoryDir)
  const globalScope = store.scope('')
  const original = (await store.readEntries(globalScope))[0]
  assert.ok(original)
  const searched = await searchTool.execute({ query: '用户居住地' }, { agent } as never) as MemoryContext
  const renderedSearch = searchTool.output.render({ query: '用户居住地' }, searched as never)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
  assert.match(renderedSearch, new RegExp(`\\[global:${original.id}\\]`, 'u'))
  const result = await updateTool.execute({
    scope: 'workspace',
    id: original.id,
    content: '用户现居上海市青浦区。',
  }, { agent } as never) as { scope: string; updated: boolean }

  assert.deepEqual(result, { scope: 'global', updated: true })
  const globalEntries = await store.readEntries(globalScope)
  assert.equal(globalEntries.length, 1)
  assert.equal(globalEntries[0]?.content, '用户现居上海市青浦区。')
  assert.equal(globalEntries[0]?.title, '用户居住地')
  assert.equal(globalEntries[0]?.description, '用户现居上海市')
  assert.equal(globalEntries[0]?.type, 'fact')
  assert.deepEqual(globalEntries[0]?.tags, ['用户信息', '居住地'])
  assert.equal(globalEntries[0]?.importance, 2)
  assert.equal(globalEntries[0]?.revisions?.[0]?.content, '用户现居上海市，尚未提供具体区。')
  assert.deepEqual(await store.readEntries(store.scope(workspace)), [])
})

test('builds validated semantic topic pages without asking the model to copy source IDs', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-semantic-runtime-'))
  const workspace = join(memoryDir, 'project')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new HybridMemoryAdapter()
  ctx.llm.registerAdapter(['hybrid'], adapter)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    checkpointTurns: 1,
    semanticSummaryDelayMs: 10,
    semanticSummaryIntervalMs: 86_400_000,
    summarizeProvider: 'hybrid',
    summarizeModel: 'hybrid',
  })
  await flushAsyncWork()

  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  const result = await memory.checkpoint({
    cwd: workspace,
    reason: 'task-end',
    force: true,
    messages: [{ id: 'u-semantic', role: 'user', text: '请记住我现在住在上海。' }],
  })
  assert.equal(result.status, 'committed')

  const store = new WorkspaceMemoryStore(memoryDir)
  const scope = store.scope(workspace)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await store.readRepresentationManifest(scope)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(adapter.requests.length, 2)
  const metadata = await store.readRepresentationManifest(scope)
  assert.equal(metadata?.topics['project-overview']?.sourceIds.length, 1)
  assert.match(await store.readSummary(scope), /用户画像：现居上海/u)
  const state = await store.readState(scope)
  assert.equal(state.distillation.calls, 2)
  assert.equal(state.distillation.totalTokens, 370)
})

test('recovers an overdue pending scope when the runtime starts', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-recovery-'))
  const workspace = join(memoryDir, 'project')
  onTestFinished(async () => {
    await ctx.fiber.dispose()
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
  assert.equal(recovered.matches[0]?.content, 'Voco 前台通过可选 workspaceMemory 接口读取长期记忆。')
  assert.equal(recovered.summary, '')
})

test('retries one invalid JSON response inside the same checkpoint', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-retry-'))
  const workspace = join(memoryDir, 'project')
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(memoryDir, { recursive: true, force: true })
  })
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new SequenceMemoryAdapter([
    'not valid json',
    '{"version":1,"operations":[{"op":"add","content":"重试成功后写入的事实。"}]}',
  ])
  ctx.llm.registerAdapter(['test'], adapter)
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
  const result = await memory.checkpoint({
    sessionId: session.id,
    reason: 'segment-end',
    messages: [{ id: 'retry-user', role: 'user', text: '第一次蒸馏会失败。' }],
  })
  assert.equal(result.status, 'committed', JSON.stringify(result))
  assert.equal(adapter.requests.length, 2)
  assert.equal(adapter.requests[0]?.maxTokens, undefined)
  const state = await new WorkspaceMemoryStore(memoryDir).readState(new WorkspaceMemoryStore(memoryDir).scope(workspace))
  assert.equal(state.pendingMessages.length, 0)
})

test('splits a max-token distillation once and records actual token usage', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-max-tokens-'))
  const workspace = join(memoryDir, 'project')
  const ctx = new Context()
  const adapter = new MaxTokenMemoryAdapter()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], adapter)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    checkpointTurns: 1,
    summarizeProvider: 'test',
    summarizeModel: 'test',
  })
  await flushAsyncWork()

  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  const result = await memory.checkpoint({
    cwd: workspace,
    reason: 'explicit',
    messages: [
      { id: 'max-token-a', role: 'user', text: '项目使用 PostgreSQL。' },
      { id: 'max-token-b', role: 'user', text: '部署目标为 Linux。' },
    ],
  })
  assert.equal(result.status, 'committed', JSON.stringify(result))
  assert.equal(adapter.requests.length, 3)
  assert.ok(adapter.requests.every(request => request.maxTokens === undefined))
  const state = await new WorkspaceMemoryStore(memoryDir).readState(new WorkspaceMemoryStore(memoryDir).scope(workspace))
  assert.equal(state.pendingMessages.length, 0)
  assert.deepEqual(state.distillation, {
    calls: 3,
    failures: 1,
    inputTokens: 180,
    outputTokens: 1540,
    totalTokens: 1720,
    todayDate: state.distillation.todayDate,
    todayTokens: 1720,
    todayInputTokens: 180,
    todayCacheReadTokens: 0,
    todayCacheWriteTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    consecutiveFailures: 0,
    blocked: false,
    lastFinishReason: 'stop',
    lastCallAt: state.distillation.lastCallAt,
  })
})

test('blocks permanently invalid JSON after one recovery call', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-invalid-output-'))
  const workspace = join(memoryDir, 'project')
  const ctx = new Context()
  const adapter = new SequenceMemoryAdapter(['not valid json'])
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], adapter)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    checkpointTurns: 1,
    idleCheckpointMs: 1000,
    summarizeProvider: 'test',
    summarizeModel: 'test',
  })
  await flushAsyncWork()

  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  const result = await memory.checkpoint({
    cwd: workspace,
    reason: 'explicit',
    messages: [{ id: 'invalid-output-user', role: 'user', text: '永久无效输出不能无限重试。' }],
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'invalid-output')
  assert.equal(result.blocked, true)
  const blocked = await memory.checkpoint({ cwd: workspace, reason: 'idle', messages: [] })
  assert.equal(blocked.status, 'buffered')
  assert.equal(blocked.blocked, true)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(adapter.requests.length, 2)
  const state = await new WorkspaceMemoryStore(memoryDir).readState(new WorkspaceMemoryStore(memoryDir).scope(workspace))
  assert.equal(state.pendingMessages.length, 1)
  assert.equal(state.distillation.blocked, true)
  assert.equal(state.distillation.consecutiveFailures, 1)
})

test('queues derived DSH 0.2.2 messages without re-distilling recalled memory', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-events-'))
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
  for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context'] as const) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `运行时注入 ${kind} 不能进入蒸馏。` }],
      source: { kind } as never,
    }), { surfaceOp: 'append' })
  }
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
  assert.doesNotMatch(requestText, /运行时注入/u)
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
    await ctx.fiber.dispose()
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
    await ctx.fiber.dispose()
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
    await ctx.fiber.dispose()
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
  const prepared = await store.prepareSemanticSummary(scope, 0)
  assert.equal(prepared.status, 'ready')
  if (prepared.status !== 'ready') throw new Error('browser seed representation was not ready')
  assert.equal(await store.commitSemanticSummary(
    scope,
    prepared,
    [{ id: 'architecture', content: '项目数据库使用 MySQL。', sourceIds: ['manual-entry'] }],
    3000,
  ), true)
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
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
  const scopeHandler = webServer.routes.get('/workspace-memory/api/v1/scope')
  const settingsHandler = webServer.routes.get('/workspace-memory/api/v1/settings')
  const retryHandler = webServer.routes.get('/workspace-memory/api/v1/retry')
  const entryHandler = webServer.routes.get('/workspace-memory/api/v1/entry')
  assert.ok(scopesHandler)
  assert.ok(scopeHandler)
  assert.ok(settingsHandler)
  assert.ok(retryHandler)
  assert.ok(entryHandler)

  const scopesResponse = await requestJson(scopesHandler, '/workspace-memory/api/v1/scopes')
  assert.equal(scopesResponse.status, 200)
  const scopes = scopesResponse.body as { scopes: Array<{ cwd: string; title?: string }> }
  assert.ok(scopes.scopes.some(scope => scope.title === 'Renamed Project'))

  const scopeResponse = await requestJson(scopeHandler, `/workspace-memory/api/v1/scope?cwd=${encodeURIComponent(workspace)}`)
  assert.equal(scopeResponse.status, 200)
  const scopePayload = scopeResponse.body as { state: { distillation: { calls: number; totalTokens: number; todayTokens: number; blocked: boolean } } }
  assert.equal(scopePayload.state.distillation.calls, 0)
  assert.equal(scopePayload.state.distillation.totalTokens, 0)
  assert.equal(scopePayload.state.distillation.todayTokens, 0)
  assert.equal(scopePayload.state.distillation.blocked, false)

  const retryResponse = await requestJson(retryHandler, `/workspace-memory/api/v1/retry?cwd=${encodeURIComponent(workspace)}`, 'POST')
  assert.equal(retryResponse.status, 200)

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
  assert.equal(editedSnapshot.summary, '')
  assert.doesNotMatch(editedSnapshot.summary, /MySQL/u)

  const deleteResponse = await requestJson(entryHandler, entryUrl, 'DELETE')
  assert.equal(deleteResponse.status, 200)
  const deletedSnapshot = await new WorkspaceMemoryStore(memoryDir).readSnapshot(scope)
  assert.equal(deletedSnapshot.entries[0]?.status, 'deleted')
  assert.doesNotMatch(deletedSnapshot.summary, /数据库选型/u)
})

test('browser API permanently deletes cached memory before the same workspace path is reused', async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-memory-delete-cache-'))
  const workspace = join(memoryDir, 'recreated-project')
  const store = new WorkspaceMemoryStore(memoryDir)
  const scope = store.scope(workspace)
  await store.ensure(scope)
  await store.writeEntries(scope, [{
    id: 'deleted-project-memory',
    content: '这个工作区只用于测试玩法。',
    status: 'active',
  }])

  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(memoryDir, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(FakeWebServer)
  await ctx.plugin(FakeWorkspaceRegistry, [])
  await ctx.plugin(WorkspaceMemoryRuntime, { memoryDir })
  await flushAsyncWork()

  const webServer = ctx.get('webServer') as unknown as FakeWebServer
  const scopesHandler = webServer.routes.get('/workspace-memory/api/v1/scopes')
  const archivedScopesHandler = webServer.routes.get('/workspace-memory/api/v1/archived-scopes')
  const scopeHandler = webServer.routes.get('/workspace-memory/api/v1/scope')
  const archivedScopeHandler = webServer.routes.get('/workspace-memory/api/v1/archived-scope')
  assert.ok(scopesHandler)
  assert.ok(archivedScopesHandler)
  assert.ok(scopeHandler)
  assert.ok(archivedScopeHandler)

  const scopeUrl = `/workspace-memory/api/v1/scope?cwd=${encodeURIComponent(workspace)}`
  const before = await requestJson(scopeHandler, scopeUrl)
  assert.equal((before.body as { entries: unknown[] }).entries.length, 1)

  await requestJson(scopesHandler, '/workspace-memory/api/v1/scopes')
  const archived = await requestJson(archivedScopesHandler, '/workspace-memory/api/v1/archived-scopes')
  assert.equal((archived.body as { scopes: unknown[] }).scopes.length, 1)

  const archiveUrl = `/workspace-memory/api/v1/archived-scope?key=${encodeURIComponent(scope.key)}`
  const archivedSnapshot = await requestJson(archivedScopeHandler, archiveUrl)
  assert.equal((archivedSnapshot.body as { entries: unknown[] }).entries.length, 1)
  const purged = await requestJson(archivedScopeHandler, archiveUrl, 'DELETE')
  assert.deepEqual(purged, { status: 200, body: { deleted: true } })

  const recreated = await requestJson(scopeHandler, scopeUrl)
  assert.equal((recreated.body as { entries: unknown[] }).entries.length, 0)
  const memory = ctx.get('workspaceMemory')
  assert.ok(memory)
  assert.equal((await memory.recall({ cwd: workspace, query: '测试玩法' })).matches.length, 0)
})
