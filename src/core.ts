import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface MemoryMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export interface MemoryEntry {
  id: string
  content: string
  tags?: string[]
  importance?: number
  status?: 'active' | 'deleted'
  createdAt?: string
  updatedAt?: string
}

export interface MemoryProposal {
  content: string
  tags?: readonly string[]
  importance?: number
}

interface NormalizedMemoryProposal {
  content: string
  tags: string[]
  importance: number
}

export interface MemoryMatch {
  id: string
  content: string
  tags: string[]
  importance: number
  score: number
}

export interface MemoryContext {
  scope: string
  summary: string
  matches: MemoryMatch[]
}

export interface RecallInput {
  sessionId?: SessionId
  cwd?: string
  query: string
  maxBytes?: number
  limit?: number
}

export type CheckpointReason = 'segment-end' | 'task-end' | 'session-close' | 'compaction' | 'explicit' | 'idle'

export interface CheckpointInput {
  sessionId?: SessionId
  cwd?: string
  messages: readonly MemoryMessage[]
  reason: CheckpointReason
  force?: boolean
}

export interface CheckpointResult extends MutationResult {
  status: 'buffered' | 'empty' | 'committed' | 'failed'
  scope: string
  accepted: number
  pending: number
  error?: string
}

export interface RememberInput extends MemoryProposal {
  sessionId?: SessionId
  cwd?: string
}

export interface ForgetInput {
  sessionId?: SessionId
  cwd?: string
  id: string
}

export interface WorkspaceMemory {
  recall(input: RecallInput): Promise<MemoryContext>
  checkpoint(input: CheckpointInput): Promise<CheckpointResult>
}

export interface MemoryEngineConfig {
  checkpointTurns: number
  checkpointChars: number
  idleCheckpointMs: number
  consolidateEvery: number
  summaryMaxBytes: number
  recallMaxBytes: number
  recallLimit: number
  checkpointMaxChars: number
  keepSummaryVersions: number
}

export interface WorkspaceScope {
  key: string
  cwd: string
  dir: string
}

export interface MemoryState {
  version: number
  checkpointCount: number
  lastCheckpointAt: number
  lastBufferedAt: number
  pendingMessages: MemoryMessage[]
  seenMessageIds: string[]
}

export interface MutationResult {
  added: number
  updated: number
  ignored: number
}

export interface DistillInput {
  scope: WorkspaceScope
  messages: readonly MemoryMessage[]
  reason: CheckpointReason
}

export interface WorkspaceMemoryEngineOptions {
  store: WorkspaceMemoryStore
  distill(input: DistillInput): Promise<readonly unknown[]>
  config?: Partial<MemoryEngineConfig>
}

export const SUMMARY_FILE = 'memory_summary.md'
export const ENTRIES_FILE = 'memory_entries.json'
export const STATE_FILE = 'state.json'
export const CHECKPOINT_DIR = 'checkpoints'
export const HISTORY_DIR = 'summary_history'

const DEFAULT_STATE: Readonly<MemoryState> = Object.freeze({
  version: 0,
  checkpointCount: 0,
  lastCheckpointAt: 0,
  lastBufferedAt: 0,
  pendingMessages: [],
  seenMessageIds: [],
})

/** Resolve a stable workspace identity. Empty cwd intentionally means global. */
export function normalizeWorkspacePath(cwd: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (typeof cwd !== 'string' || cwd.trim() === '') return ''
  const absolute = isAbsolute(cwd) ? normalize(cwd) : resolve(cwd)
  const slashed = absolute.replaceAll('\\', '/').replace(/\/$/u, '')
  return platform === 'win32' ? slashed.toLowerCase() : slashed
}

/** Hash the canonical workspace path without exposing it in a directory name. */
export function scopeKeyForCwd(cwd: string | undefined, platform: NodeJS.Platform = process.platform): string {
  const normalized = normalizeWorkspacePath(cwd, platform)
  if (normalized === '') return 'global'
  return `ws-${createHash('sha256').update(normalized).digest('hex').slice(0, 20)}`
}

/** UTF-8 safe truncation used for every model-facing memory budget. */
export function truncateUtf8(value: unknown, maxBytes: number): string {
  const text = String(value ?? '')
  const budget = Math.max(0, Math.trunc(maxBytes))
  const bytes = Buffer.from(text)
  if (bytes.length <= budget) return text
  if (budget === 0) return ''
  let end = budget
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8').trimEnd()
}

export function normalizeMemoryText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ')
    .trim()
}

function cjkCharacters(value: string): string[] {
  return [...value.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)]
    .map(match => match[0])
}

function cjkBigrams(value: string): string[] {
  const chars = cjkCharacters(value)
  if (chars.length === 1) return chars
  const result: string[] = []
  for (let index = 0; index + 1 < chars.length; index += 1) result.push((chars[index] ?? '') + (chars[index + 1] ?? ''))
  return result
}

/** Zero-dependency tokens for exact, ASCII-word, and CJK-bigram retrieval. */
export function lexicalTokens(value: unknown): string[] {
  const normalized = normalizeMemoryText(value)
  const ascii = normalized.match(/[a-z0-9][a-z0-9_.:/#-]*/gu) ?? []
  const unicodeWords = normalized
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ')
    .match(/[\p{L}\p{N}][\p{L}\p{N}_.:/#-]*/gu) ?? []
  return [...new Set([...ascii, ...unicodeWords, ...cjkBigrams(normalized)].filter(token => token.length > 0))]
}

function daysSince(iso: string | undefined, now: number): number {
  if (iso === undefined) return 365
  const time = Date.parse(iso)
  return Number.isFinite(time) ? Math.max(0, now - time) / 86_400_000 : 365
}

/** Rank parsed entries without BM25 or embeddings. */
export function searchEntries(
  entries: readonly MemoryEntry[],
  query: string,
  options: { limit?: number; now?: number } = {},
): Array<{ entry: MemoryEntry; score: number; matchedTokens: number }> {
  const normalizedQuery = normalizeMemoryText(query)
  if (normalizedQuery === '') return []
  const queryTokens = lexicalTokens(normalizedQuery)
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 8)))
  const now = options.now ?? Date.now()
  const ranked: Array<{ entry: MemoryEntry; score: number; matchedTokens: number }> = []
  for (const entry of entries) {
    if (entry.status === 'deleted') continue
    const haystack = normalizeMemoryText(`${entry.content} ${(entry.tags ?? []).join(' ')}`)
    const haystackTokens = new Set(lexicalTokens(haystack))
    let score = haystack.includes(normalizedQuery) ? 30 : 0
    let matched = 0
    for (const token of queryTokens) {
      if (haystack.includes(token) || haystackTokens.has(token)) {
        matched += 1
        score += token.length >= 4 ? 5 : 2
      }
    }
    if (matched === 0) continue
    const coverage = queryTokens.length === 0 ? 0 : matched / queryTokens.length
    score += coverage * 12
    score += Math.max(0, Math.min(3, Number(entry.importance ?? 1))) * 1.5
    score += Math.max(0, 3 - Math.log2(1 + daysSince(entry.updatedAt ?? entry.createdAt, now)))
    ranked.push({ entry, score, matchedTokens: matched })
  }
  return ranked
    .sort((left, right) => right.score - left.score || String(right.entry.updatedAt).localeCompare(String(left.entry.updatedAt)))
    .slice(0, limit)
}

function tokenDice(left: string, right: string): number {
  const a = new Set(lexicalTokens(left))
  const b = new Set(lexicalTokens(right))
  if (a.size === 0 || b.size === 0) return normalizeMemoryText(left) === normalizeMemoryText(right) ? 1 : 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return 2 * shared / (a.size + b.size)
}

export function redactSecrets(value: unknown): string {
  return String(value ?? '')
    .replace(/\b(sk-[a-z0-9_-]{12,})\b/giu, '[REDACTED]')
    .replace(/\b(gh[pousr]_[a-z0-9]{20,})\b/giu, '[REDACTED]')
    .replace(/\b((?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]')
}

export function containsSecret(value: unknown): boolean {
  return redactSecrets(value) !== String(value ?? '')
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function validEntry(value: unknown): value is MemoryEntry {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.content === 'string'
}

function validMessage(value: unknown): value is MemoryMessage {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.role === 'user' || value.role === 'assistant')
    && typeof value.text === 'string'
}

function scopeDirectory(root: string, key: string): string {
  return key === 'global' ? join(root, 'global') : join(root, 'scopes', key)
}

function deterministicSummary(entries: readonly MemoryEntry[], maxBytes: number): string {
  const active = entries
    .filter(entry => entry.status !== 'deleted')
    .sort((left, right) => Number(right.importance ?? 1) - Number(left.importance ?? 1)
      || String(right.updatedAt).localeCompare(String(left.updatedAt)))
  const lines = ['# Workspace memory', '', 'Durable reference facts maintained by dsh-workspace-memory.', '']
  for (const entry of active) {
    const tags = (entry.tags ?? []).length > 0 ? ` [${entry.tags?.join(', ')}]` : ''
    const candidate = `- ${entry.content}${tags}`
    if (Buffer.byteLength([...lines, candidate, ''].join('\n')) > maxBytes) break
    lines.push(candidate)
  }
  return lines.join('\n').trimEnd() + '\n'
}

function checkpointMarkdown(
  reason: CheckpointReason,
  messages: readonly MemoryMessage[],
  proposals: readonly unknown[],
  result: MutationResult,
  at: string,
): string {
  const messageText = messages.map(message => `- **${message.role}**: ${message.text}`).join('\n')
  const proposalText = proposals.map(proposal => `- ${normalizeProposal(proposal)?.content ?? '(ignored invalid proposal)'}`).join('\n') || '- (none)'
  return [
    `# Memory checkpoint ${at}`,
    '',
    `Reason: ${reason}`,
    '',
    '## Conversation',
    '',
    messageText || '- (none)',
    '',
    '## Durable facts',
    '',
    proposalText,
    '',
    `Result: added=${result.added}, updated=${result.updated}, ignored=${result.ignored}`,
    '',
  ].join('\n')
}

export function checkpointEligible(
  state: Pick<MemoryState, 'pendingMessages' | 'lastBufferedAt'>,
  reason: CheckpointReason,
  config: Pick<MemoryEngineConfig, 'checkpointTurns' | 'checkpointChars' | 'idleCheckpointMs'>,
  now = Date.now(),
): boolean {
  const forceReasons = new Set<CheckpointReason>(['task-end', 'session-close', 'compaction', 'explicit', 'idle'])
  if (forceReasons.has(reason)) return state.pendingMessages.length > 0
  const turns = state.pendingMessages.filter(message => message.role === 'user').length
  const chars = state.pendingMessages.reduce((sum, message) => sum + message.text.length, 0)
  return turns >= config.checkpointTurns || chars >= config.checkpointChars
    || (state.pendingMessages.length > 0 && state.lastBufferedAt > 0 && now - state.lastBufferedAt >= config.idleCheckpointMs)
}

/** Filesystem implementation. All public mutation methods serialize per scope. */
export class WorkspaceMemoryStore {
  readonly root: string
  readonly now: () => number
  readonly uuid: () => string
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(root: string, options: { now?: () => number; uuid?: () => string } = {}) {
    this.root = resolve(root)
    this.now = options.now ?? (() => Date.now())
    this.uuid = options.uuid ?? randomUUID
  }

  scope(cwd?: string): WorkspaceScope {
    const normalizedCwd = normalizeWorkspacePath(cwd)
    const key = scopeKeyForCwd(normalizedCwd)
    return { key, cwd: normalizedCwd, dir: scopeDirectory(this.root, key) }
  }

  async withScope<T>(scope: WorkspaceScope, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(scope.key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    this.locks.set(scope.key, current)
    try {
      return await current
    } finally {
      if (this.locks.get(scope.key) === current) this.locks.delete(scope.key)
    }
  }

  async ensure(scope: WorkspaceScope): Promise<void> {
    await mkdir(join(scope.dir, CHECKPOINT_DIR), { recursive: true })
    await mkdir(join(scope.dir, HISTORY_DIR), { recursive: true })
    const descriptor = join(scope.dir, 'scope.json')
    if (!existsSync(descriptor)) await this.writeAtomic(descriptor, JSON.stringify({ key: scope.key, cwd: scope.cwd }, null, 2) + '\n')
  }

  async readEntries(scope: WorkspaceScope): Promise<MemoryEntry[]> {
    const raw = await readFile(join(scope.dir, ENTRIES_FILE), 'utf8').catch(() => '[]')
    try {
      return safeArray(JSON.parse(raw) as unknown).filter(validEntry)
    } catch {
      return []
    }
  }

  async readState(scope: WorkspaceScope): Promise<MemoryState> {
    const raw = await readFile(join(scope.dir, STATE_FILE), 'utf8').catch(() => '')
    try {
      const value: unknown = JSON.parse(raw)
      if (!isRecord(value)) throw new Error('invalid memory state')
      return {
        version: typeof value.version === 'number' ? value.version : DEFAULT_STATE.version,
        checkpointCount: typeof value.checkpointCount === 'number' ? value.checkpointCount : DEFAULT_STATE.checkpointCount,
        lastCheckpointAt: typeof value.lastCheckpointAt === 'number' ? value.lastCheckpointAt : DEFAULT_STATE.lastCheckpointAt,
        lastBufferedAt: typeof value.lastBufferedAt === 'number' ? value.lastBufferedAt : DEFAULT_STATE.lastBufferedAt,
        pendingMessages: safeArray(value.pendingMessages).filter(validMessage),
        seenMessageIds: safeArray(value.seenMessageIds).filter((item): item is string => typeof item === 'string'),
      }
    } catch {
      return { ...DEFAULT_STATE, pendingMessages: [], seenMessageIds: [] }
    }
  }

  async readSummary(scope: WorkspaceScope): Promise<string> {
    return readFile(join(scope.dir, SUMMARY_FILE), 'utf8').catch(() => '')
  }

  async writeEntries(scope: WorkspaceScope, entries: readonly MemoryEntry[]): Promise<void> {
    await this.writeAtomic(join(scope.dir, ENTRIES_FILE), JSON.stringify(entries, null, 2) + '\n')
  }

  async writeState(scope: WorkspaceScope, state: MemoryState): Promise<void> {
    await this.writeAtomic(join(scope.dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n')
  }

  async rebuildSummary(scope: WorkspaceScope, entries: readonly MemoryEntry[], maxBytes: number, keepHistory = 10): Promise<void> {
    const file = join(scope.dir, SUMMARY_FILE)
    const previous = await readFile(file, 'utf8').catch(() => '')
    if (previous.trim() !== '') {
      const history = join(scope.dir, HISTORY_DIR, `${String(this.now())}-${this.uuid()}.md`)
      await this.writeAtomic(history, previous)
    }
    await this.writeAtomic(file, deterministicSummary(entries, maxBytes))
    const historyFiles = (await readdir(join(scope.dir, HISTORY_DIR)).catch(() => [])).sort().reverse()
    for (const stale of historyFiles.slice(Math.max(0, keepHistory))) {
      await unlink(join(scope.dir, HISTORY_DIR, stale)).catch(() => {})
    }
  }

  async writeCheckpoint(
    scope: WorkspaceScope,
    reason: CheckpointReason,
    messages: readonly MemoryMessage[],
    proposals: readonly unknown[],
    result: MutationResult,
  ): Promise<void> {
    const at = new Date(this.now()).toISOString().replaceAll(':', '-')
    const file = join(scope.dir, CHECKPOINT_DIR, `${at}.${this.uuid()}.md`)
    await this.writeAtomic(file, checkpointMarkdown(reason, messages, proposals, result, at))
  }

  async writeAtomic(file: string, text: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${this.uuid()}.tmp`
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, file)
  }
}

function normalizeProposal(value: unknown): NormalizedMemoryProposal | undefined {
  if (!isRecord(value)) return undefined
  const content = typeof value.content === 'string' ? value.content.trim() : ''
  if (content.length < 4 || containsSecret(content)) return undefined
  const tags = [...new Set(safeArray(value.tags)
    .filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean))].slice(0, 8)
  const importance = Math.max(0, Math.min(3, Math.trunc(Number(value.importance ?? 1))))
  return { content, tags, importance: Number.isFinite(importance) ? importance : 1 }
}

function applyProposals(
  entries: MemoryEntry[],
  proposals: readonly unknown[],
  nowIso: string,
  uuid: () => string,
): MutationResult {
  let added = 0
  let updated = 0
  let ignored = 0
  for (const proposal of proposals) {
    const normalized = normalizeProposal(proposal)
    if (normalized === undefined) {
      ignored += 1
      continue
    }
    const duplicate = entries
      .filter(entry => entry.status !== 'deleted')
      .map(entry => ({ entry, similarity: tokenDice(entry.content, normalized.content) }))
      .sort((left, right) => right.similarity - left.similarity)[0]
    if (duplicate !== undefined && duplicate.similarity >= 0.68) {
      duplicate.entry.content = normalized.content.length >= duplicate.entry.content.length ? normalized.content : duplicate.entry.content
      duplicate.entry.tags = [...new Set([...(duplicate.entry.tags ?? []), ...normalized.tags])]
      duplicate.entry.importance = Math.max(Number(duplicate.entry.importance ?? 1), normalized.importance)
      duplicate.entry.updatedAt = nowIso
      updated += 1
      continue
    }
    entries.push({
      id: `mem-${uuid().replaceAll('-', '').slice(0, 12)}`,
      content: normalized.content,
      tags: normalized.tags,
      importance: normalized.importance,
      status: 'active',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    added += 1
  }
  return { added, updated, ignored }
}

/** Deep memory module used by both the Cordis adapter and isolated tests. */
export class WorkspaceMemoryEngine {
  readonly store: WorkspaceMemoryStore
  readonly config: MemoryEngineConfig
  private readonly distill: WorkspaceMemoryEngineOptions['distill']

  constructor(options: WorkspaceMemoryEngineOptions) {
    this.store = options.store
    this.distill = options.distill
    this.config = {
      checkpointTurns: options.config?.checkpointTurns ?? 10,
      checkpointChars: options.config?.checkpointChars ?? 4000,
      idleCheckpointMs: options.config?.idleCheckpointMs ?? 300_000,
      consolidateEvery: options.config?.consolidateEvery ?? 5,
      summaryMaxBytes: options.config?.summaryMaxBytes ?? 3000,
      recallMaxBytes: options.config?.recallMaxBytes ?? 5000,
      recallLimit: options.config?.recallLimit ?? 8,
      checkpointMaxChars: options.config?.checkpointMaxChars ?? 40_000,
      keepSummaryVersions: options.config?.keepSummaryVersions ?? 10,
    }
  }

  async recall(input: RecallInput): Promise<MemoryContext> {
    const scope = this.store.scope(input.cwd)
    return this.store.withScope(scope, async () => {
      await this.store.ensure(scope)
      const [summary, entries] = await Promise.all([this.store.readSummary(scope), this.store.readEntries(scope)])
      const matches = searchEntries(entries, input.query, { limit: input.limit ?? this.config.recallLimit })
        .map(({ entry, score }) => ({ id: entry.id, content: redactSecrets(entry.content), tags: entry.tags ?? [], importance: entry.importance ?? 1, score }))
      const budget = input.maxBytes ?? this.config.recallMaxBytes
      let remaining = Math.max(0, budget - Buffer.byteLength(summary))
      const boundedMatches: MemoryMatch[] = []
      for (const match of matches) {
        const bytes = Buffer.byteLength(match.content)
        if (bytes > remaining) continue
        boundedMatches.push(match)
        remaining -= bytes
      }
      return {
        scope: scope.key,
        summary: redactSecrets(truncateUtf8(summary, Math.min(budget, this.config.summaryMaxBytes))),
        matches: boundedMatches,
      }
    })
  }

  async checkpoint(input: CheckpointInput): Promise<CheckpointResult> {
    const scope = this.store.scope(input.cwd)
    return this.store.withScope(scope, async () => {
      await this.store.ensure(scope)
      const state = await this.store.readState(scope)
      const known = new Set([...state.seenMessageIds, ...state.pendingMessages.map(message => message.id)])
      let accepted = 0
      for (const message of safeArray(input.messages)) {
        if (!validMessage(message) || known.has(message.id) || message.text.trim() === '') continue
        state.pendingMessages.push({ id: message.id, role: message.role, text: message.text.trim() })
        known.add(message.id)
        accepted += 1
      }
      if (accepted > 0) state.lastBufferedAt = this.store.now()
      if (accepted === 0 && state.pendingMessages.length === 0) {
        return { status: 'empty', scope: scope.key, accepted: 0, pending: 0, added: 0, updated: 0, ignored: 0 }
      }
      const eligible = input.force === true || checkpointEligible(state, input.reason, this.config, this.store.now())
      if (!eligible) {
        await this.store.writeState(scope, state)
        return { status: 'buffered', scope: scope.key, accepted, pending: state.pendingMessages.length, added: 0, updated: 0, ignored: 0 }
      }
      if (state.pendingMessages.length === 0) {
        return { status: 'empty', scope: scope.key, accepted, pending: 0, added: 0, updated: 0, ignored: 0 }
      }
      const staged: MemoryMessage[] = []
      let chars = 0
      for (const message of state.pendingMessages) {
        if (chars >= this.config.checkpointMaxChars) break
        const available = this.config.checkpointMaxChars - chars
        const text = message.text.slice(0, available)
        staged.push({ ...message, text })
        chars += text.length
      }
      let proposals: readonly unknown[]
      try {
        proposals = safeArray(await this.distill({ scope, messages: staged, reason: input.reason }))
      } catch (error) {
        await this.store.writeState(scope, state)
        return {
          status: 'failed',
          scope: scope.key,
          accepted,
          pending: state.pendingMessages.length,
          added: 0,
          updated: 0,
          ignored: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      const entries = await this.store.readEntries(scope)
      const nowIso = new Date(this.store.now()).toISOString()
      const result = applyProposals(entries, proposals, nowIso, this.store.uuid)
      state.seenMessageIds = [...state.seenMessageIds, ...staged.map(message => message.id)].slice(-1024)
      const stagedIds = new Set(staged.map(message => message.id))
      state.pendingMessages = state.pendingMessages.filter(message => !stagedIds.has(message.id))
      state.lastCheckpointAt = this.store.now()
      state.checkpointCount += 1
      await this.store.writeEntries(scope, entries)
      if (state.checkpointCount % this.config.consolidateEvery === 0 || !(await this.store.readSummary(scope)).trim()) {
        state.version += 1
        await this.store.rebuildSummary(scope, entries, this.config.summaryMaxBytes, this.config.keepSummaryVersions)
      }
      await this.store.writeCheckpoint(scope, input.reason, staged, proposals, result)
      await this.store.writeState(scope, state)
      return { status: 'committed', scope: scope.key, accepted, pending: state.pendingMessages.length, ...result }
    })
  }

  async remember(input: RememberInput): Promise<{ scope: string } & MutationResult> {
    const scope = this.store.scope(input.cwd)
    return this.store.withScope(scope, async () => {
      await this.store.ensure(scope)
      const entries = await this.store.readEntries(scope)
      const proposal = normalizeProposal(input)
      if (proposal === undefined) throw new Error('memory content is empty or contains a credential-like secret')
      const result = applyProposals(entries, [proposal], new Date(this.store.now()).toISOString(), this.store.uuid)
      await this.store.writeEntries(scope, entries)
      await this.store.rebuildSummary(scope, entries, this.config.summaryMaxBytes, this.config.keepSummaryVersions)
      return { scope: scope.key, ...result }
    })
  }

  async forget(input: ForgetInput): Promise<{ scope: string; deleted: boolean }> {
    const scope = this.store.scope(input.cwd)
    return this.store.withScope(scope, async () => {
      await this.store.ensure(scope)
      const entries = await this.store.readEntries(scope)
      const entry = entries.find(candidate => candidate.id === input.id && candidate.status !== 'deleted')
      if (entry === undefined) return { scope: scope.key, deleted: false }
      entry.status = 'deleted'
      entry.updatedAt = new Date(this.store.now()).toISOString()
      await this.store.writeEntries(scope, entries)
      await this.store.rebuildSummary(scope, entries, this.config.summaryMaxBytes, this.config.keepSummaryVersions)
      return { scope: scope.key, deleted: true }
    })
  }
}
