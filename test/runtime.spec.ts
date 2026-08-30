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
