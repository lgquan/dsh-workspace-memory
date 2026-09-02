import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
  await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    checkpointTurns: 1,
    consolidateEvery: 1,
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
  await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    checkpointTurns: 10,
    checkpointChars: 4000,
    idleCheckpointMs: 1000,
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
  await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'test' })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WorkspaceMemoryRuntime, {
    memoryDir,
    checkpointTurns: 1,
    idleCheckpointMs: 1000,
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
