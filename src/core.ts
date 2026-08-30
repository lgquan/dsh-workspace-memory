import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface MemoryMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export type MemoryStatus = 'active' | 'conflict' | 'superseded' | 'deleted'

export interface MemoryRevision {
  content: string
  title: string
  description: string
  at: string
}

export interface MemoryEntry {
  id: string
  scope?: 'global' | 'workspace'
  type?: 'preference' | 'decision' | 'architecture' | 'rule' | 'fact' | 'fix'
  title?: string
  description?: string
  retrievalTerms?: string[]
  content: string
  tags?: string[]
  importance?: number
  status?: MemoryStatus
  conflictGroupId?: string
  supersedes?: string[]
  supersededBy?: string[]
  revisions?: MemoryRevision[]
  provenance?: {
    messageIds: string[]
    reason: 'explicit-correction' | 'revision' | 'manual'
  }
  createdAt?: string
  updatedAt?: string
}

export interface MemoryProposal {
  content: string
  scope?: 'global' | 'workspace'
  type?: MemoryEntry['type']
  title?: string
  description?: string
  retrievalTerms?: readonly string[]
  tags?: readonly string[]
  importance?: number
}

interface NormalizedMemoryProposal {
  content: string
  scope: 'global' | 'workspace'
  type: NonNullable<MemoryEntry['type']>
  title: string
  description: string
  retrievalTerms: string[]
  tags: string[]
  importance: number
}

export interface MemoryMatch {
  id: string
  scope: string
  title: string
  description: string
  type: string
  content: string
  tags: string[]
  importance: number
  score: number
  status?: MemoryStatus
  conflictWith?: string[]
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
  surfacedMemoryIds?: readonly string[]
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
  surfacedPenalty: number
}

export interface WorkspaceScope {
  key: string
  cwd: string
  dir: string
}

/** Filesystem snapshot used by the optional browser memory inspector. */
export interface MemoryScopeSnapshot {
  scope: WorkspaceScope
  summary: string
  entries: MemoryEntry[]
  state: MemoryState
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
  superseded?: number
  conflicts?: number
}

export interface DistillInput {
  scope: WorkspaceScope
  messages: readonly MemoryMessage[]
  reason: CheckpointReason
  existingEntries?: readonly MemoryEntry[]
}

export interface MemoryOperation extends MemoryProposal {
  op?: 'add' | 'revise' | 'supersede' | 'flag-conflict'
  targetId?: string
  targetScope?: 'global' | 'workspace'
  oldQuote?: string
  newQuote?: string
  evidenceMessageIds?: readonly string[]
}

export interface DistillOutput {
  version: 1
  operations: readonly MemoryOperation[]
}

export interface WorkspaceMemoryEngineOptions {
  store: WorkspaceMemoryStore
  distill(input: DistillInput): Promise<unknown>
  config?: Partial<MemoryEngineConfig>
}

interface OperationAudit {
  op: string
  targetId?: string
  status: 'accepted' | 'rejected'
  reason: string
}

interface AppliedOperations extends MutationResult {
  audit: OperationAudit[]
}

export const SUMMARY_FILE = 'memory_summary.md'
export const ENTRIES_FILE = 'memory_entries.json'
export const STATE_FILE = 'state.json'
export const CHECKPOINT_DIR = 'checkpoints'
export const HISTORY_DIR = 'summary_history'
export const ARCHIVE_DIR = 'archived'

const DEFAULT_STATE: Readonly<MemoryState> = Object.freeze({
  version: 0,
  checkpointCount: 0,
  lastCheckpointAt: 0,
  lastBufferedAt: 0,
  pendingMessages: [],
  seenMessageIds: [],
})

function debugMemory(event: string, fields: Record<string, unknown>): void {
  if (process.env.DSH_WORKSPACE_MEMORY_DEBUG !== '1') return
  console.debug(`[workspace-memory] ${event} ${JSON.stringify(fields)}`)
}

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

export function isRecallable(entry: MemoryEntry): boolean {
  return entry.status === undefined || entry.status === 'active' || entry.status === 'conflict'
}

export function isSummarizable(entry: MemoryEntry): boolean {
  return entry.status === undefined || entry.status === 'active'
}

export function isDedupCandidate(entry: MemoryEntry): boolean {
  return isRecallable(entry)
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
  options: { limit?: number; now?: number; surfacedMemoryIds?: readonly string[]; surfacedPenalty?: number } = {},
): Array<{ entry: MemoryEntry; score: number; matchedTokens: number }> {
  const normalizedQuery = normalizeMemoryText(query)
  if (normalizedQuery === '') return []
  const queryTokens = lexicalTokens(normalizedQuery)
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 8)))
  const now = options.now ?? Date.now()
  const surfaced = new Set(options.surfacedMemoryIds ?? [])
  const ranked: Array<{ entry: MemoryEntry; score: number; matchedTokens: number }> = []
  for (const entry of entries) {
    if (!isRecallable(entry)) continue
    const haystack = normalizeMemoryText([
      entry.content,
      entry.title,
      entry.description,
      ...(entry.tags ?? []),
      ...(entry.retrievalTerms ?? []),
    ].filter(Boolean).join(' '))
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
    const titleHit = entry.title !== undefined && normalizeMemoryText(entry.title).includes(normalizedQuery) ? 18 : 0
    const tagHit = (entry.tags ?? []).some(tag => queryTokens.includes(normalizeMemoryText(tag))) ? 8 : 0
    const termsHit = (entry.retrievalTerms ?? []).filter(term => {
      const normalizedTerm = normalizeMemoryText(term)
      if (normalizedTerm === '') return false
      if (normalizedQuery.includes(normalizedTerm)) return true
      const termTokens = lexicalTokens(normalizedTerm)
      return termTokens.some(token => queryTokens.includes(token))
    }).length * 5
    score += titleHit + tagHit + termsHit
    score += Math.max(0, Math.min(3, Number(entry.importance ?? 1))) * 1.5
    score += Math.max(0, 3 - Math.log2(1 + daysSince(entry.updatedAt ?? entry.createdAt, now)))
    if (surfaced.has(entry.id)) score -= options.surfacedPenalty ?? 8
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

function migrateEntry(entry: MemoryEntry, scope: 'global' | 'workspace'): MemoryEntry {
  const allowedStatuses = new Set<MemoryStatus>(['active', 'conflict', 'superseded', 'deleted'])
  const revisions = safeArray(entry.revisions).filter((revision): revision is MemoryRevision => isRecord(revision)
    && typeof revision.content === 'string'
    && typeof revision.title === 'string'
    && typeof revision.description === 'string'
    && typeof revision.at === 'string')
  const supersedes = safeArray(entry.supersedes).filter((id): id is string => typeof id === 'string')
  const supersededBy = safeArray(entry.supersededBy).filter((id): id is string => typeof id === 'string')
  const provenance = isRecord(entry.provenance)
    && Array.isArray(entry.provenance.messageIds)
    && entry.provenance.messageIds.every(id => typeof id === 'string')
    && (entry.provenance.reason === 'explicit-correction' || entry.provenance.reason === 'revision' || entry.provenance.reason === 'manual')
    ? { messageIds: [...entry.provenance.messageIds], reason: entry.provenance.reason }
    : undefined
  return {
    ...entry,
    scope: entry.scope ?? scope,
    type: entry.type ?? 'fact',
    title: entry.title ?? entry.content.slice(0, 80),
    description: entry.description ?? entry.content.slice(0, 240),
    retrievalTerms: entry.retrievalTerms ?? [],
    tags: entry.tags ?? [],
    importance: entry.importance ?? 1,
    status: entry.status !== undefined && allowedStatuses.has(entry.status) ? entry.status : 'active',
    ...(revisions.length === 0 ? {} : { revisions }),
    ...(supersedes.length === 0 ? {} : { supersedes }),
    ...(supersededBy.length === 0 ? {} : { supersededBy }),
    ...(provenance === undefined ? {} : { provenance }),
  }
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

function archivedScopeDirectory(root: string, key: string): string {
  return join(root, ARCHIVE_DIR, key)
}

function deterministicSummary(entries: readonly MemoryEntry[], maxBytes: number, heading = '# 项目记忆'): string {
  const active = entries
    .filter(isSummarizable)
    .sort((left, right) => Number(right.importance ?? 1) - Number(left.importance ?? 1)
      || String(right.updatedAt).localeCompare(String(left.updatedAt)))
  const lines = [heading, '', '由 dsh-workspace-memory 维护的长期事实。', '']
  for (const entry of active) {
    const tags = (entry.tags ?? []).length > 0 ? ` [${entry.tags?.join(', ')}]` : ''
    const candidate = `- ${entry.title ?? entry.content}: ${entry.description ?? entry.content}${tags}`
    if (Buffer.byteLength([...lines, candidate, ''].join('\n')) > maxBytes) break
    lines.push(candidate)
  }
  return lines.join('\n').trimEnd() + '\n'
}

function checkpointMarkdown(
  reason: CheckpointReason,
  messages: readonly MemoryMessage[],
  operations: readonly MemoryOperation[],
  result: MutationResult,
  audit: readonly OperationAudit[],
  at: string,
): string {
  const messageText = messages.map(message => `- **${message.role}**: ${message.text}`).join('\n')
  const proposalText = operations.map(operation => `- ${operation.op ?? 'add'}: ${normalizeProposal(operation)?.content ?? '(invalid operation)'}`).join('\n') || '- (none)'
  const auditText = audit.map(item => `- ${item.status}: ${item.op}${item.targetId === undefined ? '' : ` ${item.targetId}`} (${item.reason})`).join('\n') || '- (none)'
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
    '## Operation audit',
    '',
    auditText,
    '',
    `Result: added=${result.added}, updated=${result.updated}, superseded=${result.superseded ?? 0}, conflicts=${result.conflicts ?? 0}, ignored=${result.ignored}`,
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
  private readonly snapshotCache = new Map<string, MemoryScopeSnapshot>()
  private readonly snapshotGenerations = new Map<string, number>()

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
    const queuedAt = this.now()
    const current = previous.catch(() => {}).then(async () => {
      debugMemory('scope-lock-acquired', { scope: scope.key, waitMs: Math.max(0, this.now() - queuedAt) })
      return operation()
    })
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
    if (!existsSync(descriptor)) {
      try {
        await writeFile(descriptor, JSON.stringify({ key: scope.key, cwd: scope.cwd }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }

  async readEntries(scope: WorkspaceScope): Promise<MemoryEntry[]> {
    const raw = await readFile(join(scope.dir, ENTRIES_FILE), 'utf8').catch(() => '[]')
    try {
      return safeArray(JSON.parse(raw) as unknown).filter(validEntry).map(entry => migrateEntry(entry, scope.key === 'global' ? 'global' : 'workspace'))
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
    const raw = await readFile(join(scope.dir, SUMMARY_FILE), 'utf8').catch(() => '')
    return raw
      .replace(/^# Global memory$/mu, '# 全局记忆')
      .replace(/^# Workspace memory$/mu, '# 项目记忆')
      .replace(/^Durable reference facts maintained by dsh-workspace-memory\.$/mu, '由 dsh-workspace-memory 维护的长期事实。')
  }

  /** List persisted scopes without creating directories for unused projects. */
  async listScopes(): Promise<WorkspaceScope[]> {
    const global = this.scope('')
    const result: WorkspaceScope[] = [global]
    const directories = await readdir(join(this.root, 'scopes'), { withFileTypes: true }).catch(() => [])
    for (const directory of directories) {
      if (!directory.isDirectory() || !/^ws-[a-f0-9]{20}$/u.test(directory.name)) continue
      const descriptor = join(this.root, 'scopes', directory.name, 'scope.json')
      const raw = await readFile(descriptor, 'utf8').catch(() => '')
      try {
        const value: unknown = JSON.parse(raw)
        if (!isRecord(value) || typeof value.cwd !== 'string' || value.cwd.trim() === '') continue
        const scope = this.scope(value.cwd)
        if (scope.key !== directory.name) continue
        result.push(scope)
      } catch {
        // Ignore incomplete or manually removed scope descriptors.
      }
    }
    return result.sort((left, right) => left.key === 'global' ? -1 : right.key === 'global' ? 1 : left.cwd.localeCompare(right.cwd))
  }

  /** List workspace scopes moved to the recoverable archive. */
  async listArchivedScopes(): Promise<WorkspaceScope[]> {
    const result: WorkspaceScope[] = []
    const directories = await readdir(join(this.root, ARCHIVE_DIR), { withFileTypes: true }).catch(() => [])
    for (const directory of directories) {
      if (!directory.isDirectory() || !/^ws-[a-f0-9]{20}$/u.test(directory.name)) continue
      const descriptor = join(archivedScopeDirectory(this.root, directory.name), 'scope.json')
      const raw = await readFile(descriptor, 'utf8').catch(() => '')
      try {
        const value: unknown = JSON.parse(raw)
        if (!isRecord(value) || typeof value.cwd !== 'string' || value.cwd.trim() === '') continue
        const scope = this.scope(value.cwd)
        if (scope.key === directory.name) result.push(scope)
      } catch {
        // Ignore incomplete archive descriptors.
      }
    }
    return result.sort((left, right) => left.cwd.localeCompare(right.cwd))
  }

  /** Move one workspace scope to the recoverable archive. */
  async archiveScope(scope: WorkspaceScope): Promise<boolean> {
    if (scope.key === 'global' || !existsSync(scope.dir)) return false
    return this.withScope(scope, async () => {
      if (!existsSync(scope.dir)) return false
      const destination = archivedScopeDirectory(this.root, scope.key)
      await mkdir(join(this.root, ARCHIVE_DIR), { recursive: true })
      if (existsSync(destination)) return false
      await rename(scope.dir, destination)
      return true
    })
  }

  /** Permanently remove one archived scope and all of its history/checkpoints. */
  async purgeArchivedScope(scope: WorkspaceScope): Promise<boolean> {
    if (scope.key === 'global') return false
    const directory = archivedScopeDirectory(this.root, scope.key)
    if (!existsSync(directory)) return false
    await rm(directory, { recursive: true, force: true })
    return true
  }

  /** Read one scope without forcing initialization or writing any files. */
  async readSnapshot(scope: WorkspaceScope): Promise<MemoryScopeSnapshot> {
    const cacheKey = `${scope.key}:${scope.dir}`
    const cached = this.snapshotCache.get(cacheKey)
    if (cached !== undefined) return cloneSnapshot(cached)
    const generation = this.snapshotGenerations.get(cacheKey) ?? 0
    const startedAt = this.now()
    const [summary, entries, state] = await Promise.all([
      this.readSummary(scope),
      this.readEntries(scope),
      this.readState(scope),
    ])
    const snapshot = { scope, summary, entries, state }
    if ((this.snapshotGenerations.get(cacheKey) ?? 0) === generation) {
      this.snapshotCache.set(cacheKey, cloneSnapshot(snapshot))
    }
    debugMemory('snapshot-loaded', {
      scope: scope.key,
      durationMs: Math.max(0, this.now() - startedAt),
      entries: entries.length,
      cached: (this.snapshotGenerations.get(cacheKey) ?? 0) === generation,
    })
    return cloneSnapshot(snapshot)
  }

  /** Read a scope that currently lives in the recoverable archive. */
  async readArchivedSnapshot(scope: WorkspaceScope): Promise<MemoryScopeSnapshot> {
    return this.readSnapshot({ ...scope, dir: archivedScopeDirectory(this.root, scope.key) })
  }

  async writeEntries(scope: WorkspaceScope, entries: readonly MemoryEntry[]): Promise<void> {
    this.invalidateSnapshot(scope)
    await this.writeAtomic(join(scope.dir, ENTRIES_FILE), JSON.stringify(entries, null, 2) + '\n')
  }

  async writeState(scope: WorkspaceScope, state: MemoryState): Promise<void> {
    this.invalidateSnapshot(scope)
    await this.writeAtomic(join(scope.dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n')
  }

  async rebuildSummary(scope: WorkspaceScope, entries: readonly MemoryEntry[], maxBytes: number, keepHistory = 10): Promise<void> {
    this.invalidateSnapshot(scope)
    const file = join(scope.dir, SUMMARY_FILE)
    const previous = await readFile(file, 'utf8').catch(() => '')
    if (previous.trim() !== '') {
      const history = join(scope.dir, HISTORY_DIR, `${String(this.now())}-${this.uuid()}.md`)
      await this.writeAtomic(history, previous)
    }
    await this.writeAtomic(file, deterministicSummary(entries, maxBytes, scope.key === 'global' ? '# 全局记忆' : '# 项目记忆'))
    const historyFiles = (await readdir(join(scope.dir, HISTORY_DIR)).catch(() => [])).sort().reverse()
    for (const stale of historyFiles.slice(Math.max(0, keepHistory))) {
      await unlink(join(scope.dir, HISTORY_DIR, stale)).catch(() => {})
    }
  }

  async writeCheckpoint(
    scope: WorkspaceScope,
    reason: CheckpointReason,
    messages: readonly MemoryMessage[],
    operations: readonly MemoryOperation[],
    result: MutationResult,
    audit: readonly OperationAudit[],
  ): Promise<void> {
    const at = new Date(this.now()).toISOString().replaceAll(':', '-')
    const file = join(scope.dir, CHECKPOINT_DIR, `${at}.${this.uuid()}.md`)
    await this.writeAtomic(file, checkpointMarkdown(reason, messages, operations, result, audit, at))
  }

  async writeAtomic(file: string, text: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${this.uuid()}.tmp`
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, file)
  }

  private invalidateSnapshot(scope: WorkspaceScope): void {
    const cacheKey = `${scope.key}:${scope.dir}`
    this.snapshotCache.delete(cacheKey)
    this.snapshotGenerations.set(cacheKey, (this.snapshotGenerations.get(cacheKey) ?? 0) + 1)
  }
}

function cloneSnapshot(snapshot: MemoryScopeSnapshot): MemoryScopeSnapshot {
  return {
    scope: { ...snapshot.scope },
    summary: snapshot.summary,
    entries: snapshot.entries.map(entry => ({
      ...entry,
      ...(entry.retrievalTerms === undefined ? {} : { retrievalTerms: [...entry.retrievalTerms] }),
      ...(entry.tags === undefined ? {} : { tags: [...entry.tags] }),
      ...(entry.supersedes === undefined ? {} : { supersedes: [...entry.supersedes] }),
      ...(entry.supersededBy === undefined ? {} : { supersededBy: [...entry.supersededBy] }),
      ...(entry.revisions === undefined ? {} : { revisions: entry.revisions.map(revision => ({ ...revision })) }),
      ...(entry.provenance === undefined ? {} : { provenance: { ...entry.provenance, messageIds: [...entry.provenance.messageIds] } }),
    })),
    state: {
      ...snapshot.state,
      pendingMessages: snapshot.state.pendingMessages.map(message => ({ ...message })),
      seenMessageIds: [...snapshot.state.seenMessageIds],
    },
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
  const allowedTypes = new Set<MemoryEntry['type']>(['preference', 'decision', 'architecture', 'rule', 'fact', 'fix'])
  const candidateType = value.type
  const type: NonNullable<MemoryEntry['type']> = typeof candidateType === 'string' && allowedTypes.has(candidateType as NonNullable<MemoryEntry['type']>)
    ? candidateType as NonNullable<MemoryEntry['type']>
    : 'fact'
  const title = typeof value.title === 'string' && value.title.trim() !== '' ? value.title.trim().slice(0, 160) : content.slice(0, 80)
  const description = typeof value.description === 'string' && value.description.trim() !== '' ? value.description.trim().slice(0, 500) : content.slice(0, 240)
  const retrievalTerms = [...new Set(safeArray(value.retrievalTerms)
    .filter((term): term is string => typeof term === 'string')
    .map(term => term.trim())
    .filter(Boolean))].slice(0, 16)
  return {
    content,
    scope: value.scope === 'global' ? 'global' : 'workspace',
    type,
    title,
    description,
    retrievalTerms,
    tags,
    importance: Number.isFinite(importance) ? importance : 1,
  }
}

function normalizeOperations(value: unknown): MemoryOperation[] {
  if (Array.isArray(value)) return value.map(item => (isRecord(item) ? { ...item, op: 'add' as const } : { op: 'invalid' }) as unknown as MemoryOperation)
  if (!isRecord(value)) throw new Error('memory distiller returned an invalid operation contract')
  if (value.version === 1 && Array.isArray(value.operations)) return safeArray(value.operations).map(item => (isRecord(item) ? item : { op: 'invalid' }) as unknown as MemoryOperation)
  if (Array.isArray(value.memories)) return safeArray(value.memories).map(item => (isRecord(item) ? { ...item, op: 'add' as const } : { op: 'invalid' }) as unknown as MemoryOperation)
  throw new Error('memory distiller returned an unsupported operation contract')
}

function operationScope(operation: MemoryOperation): 'global' | 'workspace' {
  if (operation.targetScope === 'global') return 'global'
  if (operation.targetScope === 'workspace') return 'workspace'
  return operation.scope === 'global' ? 'global' : 'workspace'
}

function uniqueId(uuid: () => string): string {
  return `mem-${uuid().replaceAll('-', '').slice(0, 12)}`
}

function messageById(messages: readonly MemoryMessage[], id: string): MemoryMessage | undefined {
  return messages.find(message => message.id === id)
}

function evidenceValid(
  operation: MemoryOperation,
  target: MemoryEntry,
  messages: readonly MemoryMessage[],
): boolean {
  if (operation.newQuote === undefined || operation.newQuote.trim() === '') return false
  if (operation.oldQuote === undefined || operation.oldQuote.trim() === '') return false
  const ids = operation.evidenceMessageIds ?? []
  if (ids.length === 0) return false
  const userMessages = ids.map(id => messageById(messages, id)).filter((message): message is MemoryMessage => message?.role === 'user')
  if (userMessages.length === 0) return false
  if (!userMessages.some(message => message.text.includes(operation.newQuote ?? ''))) return false
  if (!target.content.includes(operation.oldQuote)) return false
  return true
}

interface TargetResolution {
  target?: MemoryEntry
  branches?: MemoryEntry[]
}

function resolveTarget(entries: readonly MemoryEntry[], targetId: string): TargetResolution {
  let current = entries.find(entry => entry.id === targetId)
  const seen = new Set<string>()
  while (current?.status === 'superseded' && current.supersededBy !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    const successorIds = current.supersededBy
    if (successorIds.length !== 1) {
      const branches = successorIds.map(id => entries.find(entry => entry.id === id)).filter((entry): entry is MemoryEntry => entry !== undefined)
      return branches.length > 1 ? { branches } : {}
    }
    current = entries.find(entry => entry.id === successorIds[0])
  }
  if (current?.status === 'superseded') return {}
  return current === undefined ? {} : { target: current }
}

function createConflict(
  entries: MemoryEntry[],
  targets: readonly MemoryEntry[],
  normalized: NormalizedMemoryProposal,
  nowIso: string,
  uuid: () => string,
): { id: string; group: string } {
  const existingGroups = new Set(targets.map(target => target.conflictGroupId).filter((group): group is string => group !== undefined))
  const group = existingGroups.values().next().value ?? `conflict-${uuid().replaceAll('-', '').slice(0, 12)}`
  for (const entry of entries) {
    if (!isRecallable(entry)) continue
    if (targets.some(target => target.id === entry.id) || (entry.conflictGroupId !== undefined && existingGroups.has(entry.conflictGroupId))) {
      entry.status = 'conflict'
      entry.conflictGroupId = group
      entry.updatedAt = nowIso
    }
  }
  const id = uniqueId(uuid)
  entries.push({
    id,
    scope: normalized.scope,
    type: normalized.type,
    title: normalized.title,
    description: normalized.description,
    retrievalTerms: normalized.retrievalTerms,
    content: normalized.content,
    tags: normalized.tags,
    importance: normalized.importance,
    status: 'conflict',
    conflictGroupId: group,
    createdAt: nowIso,
    updatedAt: nowIso,
  })
  return { id, group }
}

function appendRevision(entry: MemoryEntry, nowIso: string): void {
  const revisions = entry.revisions ?? []
  revisions.push({
    content: entry.content,
    title: entry.title ?? entry.content.slice(0, 80),
    description: entry.description ?? entry.content.slice(0, 240),
    at: entry.updatedAt ?? nowIso,
  })
  entry.revisions = revisions.slice(-20)
}

export function selectDistillationCandidates(
  entries: readonly MemoryEntry[],
  messages: readonly MemoryMessage[],
  maxEntries = 20,
  maxBytes = 12_000,
): MemoryEntry[] {
  const query = messages.map(message => message.text).join('\n')
  const queryTokens = new Set(lexicalTokens(query))
  const lexical = searchEntries(entries, query, { limit: Math.min(12, maxEntries) }).map(result => result.entry)
  const sameTopic = entries.filter(entry => isRecallable(entry) && [entry.type, ...(entry.tags ?? [])]
    .flatMap(value => lexicalTokens(value))
    .some(token => queryTokens.has(token)))
  const recent = entries.filter(isRecallable).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0, 8)
  const selected: MemoryEntry[] = []
  let bytes = 0
  for (const entry of [...lexical, ...sameTopic, ...recent]) {
    if (selected.some(candidate => candidate.id === entry.id)) continue
    const size = Buffer.byteLength(JSON.stringify({
      id: entry.id,
      scope: entry.scope,
      status: entry.status,
      type: entry.type,
      content: entry.content,
      tags: entry.tags,
      conflictGroupId: entry.conflictGroupId,
    }))
    if (selected.length >= maxEntries || bytes + size > maxBytes) continue
    selected.push(entry)
    bytes += size
  }
  return selected
}

function applyOperations(
  entries: MemoryEntry[],
  operations: readonly MemoryOperation[],
  nowIso: string,
  uuid: () => string,
  messages: readonly MemoryMessage[] = [],
): AppliedOperations {
  let added = 0
  let updated = 0
  let ignored = 0
  let superseded = 0
  let conflicts = 0
  const audit: OperationAudit[] = []
  for (const operation of operations) {
    const rawOp: unknown = operation.op ?? 'add'
    if (rawOp !== 'add' && rawOp !== 'revise' && rawOp !== 'supersede' && rawOp !== 'flag-conflict') {
      ignored += 1
      audit.push({ op: String(rawOp), status: 'rejected', reason: 'unsupported operation' })
      continue
    }
    if ((operation.targetScope !== undefined && operation.targetScope !== 'global' && operation.targetScope !== 'workspace')
      || (operation.scope !== undefined && operation.scope !== 'global' && operation.scope !== 'workspace')) {
      ignored += 1
      audit.push({ op: rawOp, status: 'rejected', reason: 'invalid scope' })
      continue
    }
    const normalized = normalizeProposal(operation)
    if (normalized === undefined) {
      ignored += 1
      audit.push({ op: operation.op ?? 'add', status: 'rejected', reason: 'invalid or secret-bearing content' })
      continue
    }
    const op = rawOp
    const resolution = operation.targetId === undefined ? {} : resolveTarget(entries, operation.targetId)
    const target = resolution.target
    if (resolution.branches !== undefined && (op === 'supersede' || op === 'flag-conflict')) {
      const conflict = createConflict(entries, resolution.branches, normalized, nowIso, uuid)
      conflicts += 1
      added += 1
      audit.push({ op, ...(operation.targetId === undefined ? {} : { targetId: operation.targetId }), status: 'accepted', reason: `non-unique successor downgraded to conflict group ${conflict.group}` })
      continue
    }
    if ((op === 'revise' || op === 'supersede' || op === 'flag-conflict') && (target === undefined || target.status === 'deleted')) {
      ignored += 1
      audit.push({ op, ...(operation.targetId === undefined ? {} : { targetId: operation.targetId }), status: 'rejected', reason: 'target not found, deleted, or has a non-unique successor' })
      continue
    }
    if (op === 'supersede' && (target === undefined || !evidenceValid(operation, target, messages))) {
      ignored += 1
      audit.push({ op, ...(operation.targetId === undefined ? {} : { targetId: operation.targetId }), status: 'rejected', reason: 'user evidence or verbatim quotes did not validate' })
      continue
    }
    if (op === 'revise' && target !== undefined && tokenDice(target.content, normalized.content) < 0.68) {
      ignored += 1
      audit.push({ op, targetId: target.id, status: 'rejected', reason: 'revision is not a near-duplicate; use supersede or flag-conflict' })
      continue
    }
    if (op === 'revise' && target !== undefined && isRecallable(target)) {
      appendRevision(target, nowIso)
      target.content = normalized.content
      target.title = normalized.title
      target.description = normalized.description
      target.type = normalized.type
      target.retrievalTerms = [...new Set([...(target.retrievalTerms ?? []), ...normalized.retrievalTerms])]
      target.tags = [...new Set([...(target.tags ?? []), ...normalized.tags])]
      target.importance = Math.max(Number(target.importance ?? 1), normalized.importance)
      target.updatedAt = nowIso
      target.provenance = { messageIds: [...(operation.evidenceMessageIds ?? [])], reason: 'revision' }
      updated += 1
      audit.push({ op, targetId: target.id, status: 'accepted', reason: 'revised with prior content retained' })
      continue
    }
    if (op === 'supersede' && target !== undefined) {
      const id = uniqueId(uuid)
      const supersededEntries = [target]
      target.status = 'superseded'
      target.supersededBy = [id]
      target.updatedAt = nowIso
      entries.push({
        id,
        scope: normalized.scope,
        type: normalized.type,
        title: normalized.title,
        description: normalized.description,
        retrievalTerms: normalized.retrievalTerms,
        content: normalized.content,
        tags: normalized.tags,
        importance: normalized.importance,
        status: 'active',
        supersedes: supersededEntries.map(entry => entry.id),
        provenance: { messageIds: [...(operation.evidenceMessageIds ?? [])], reason: 'explicit-correction' },
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      superseded += 1
      added += 1
      audit.push({ op, targetId: target.id, status: 'accepted', reason: `superseded ${supersededEntries.length} entr${supersededEntries.length === 1 ? 'y' : 'ies'} by ${id}` })
      continue
    }
    if (op === 'flag-conflict' && target !== undefined) {
      const conflict = createConflict(entries, [target], normalized, nowIso, uuid)
      conflicts += 1
      added += 1
      audit.push({ op, targetId: target.id, status: 'accepted', reason: `flagged conflict group ${conflict.group}` })
      continue
    }
    const duplicate = entries
      .filter(isDedupCandidate)
      .map(entry => ({ entry, similarity: tokenDice(entry.content, normalized.content) }))
      .sort((left, right) => right.similarity - left.similarity)[0]
    if (duplicate !== undefined && duplicate.similarity >= 0.68) {
      appendRevision(duplicate.entry, nowIso)
      duplicate.entry.content = normalized.content
      duplicate.entry.title = normalized.title
      duplicate.entry.description = normalized.description
      duplicate.entry.type = normalized.type
      duplicate.entry.retrievalTerms = [...new Set([...(duplicate.entry.retrievalTerms ?? []), ...normalized.retrievalTerms])]
      duplicate.entry.tags = [...new Set([...(duplicate.entry.tags ?? []), ...normalized.tags])]
      duplicate.entry.importance = Math.max(Number(duplicate.entry.importance ?? 1), normalized.importance)
      duplicate.entry.updatedAt = nowIso
      updated += 1
      audit.push({ op: 'add', targetId: duplicate.entry.id, status: 'accepted', reason: 'near-duplicate revised with prior content retained' })
      continue
    }
    entries.push({
      id: uniqueId(uuid),
      scope: normalized.scope,
      type: normalized.type,
      title: normalized.title,
      description: normalized.description,
      retrievalTerms: normalized.retrievalTerms,
      content: normalized.content,
      tags: normalized.tags,
      importance: normalized.importance,
      status: 'active',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    added += 1
    audit.push({ op: 'add', status: 'accepted', reason: 'new durable memory' })
  }
  return { added, updated, ignored, superseded, conflicts, audit }
}

/** Deep memory module used by both the Cordis adapter and isolated tests. */
export class WorkspaceMemoryEngine {
  readonly store: WorkspaceMemoryStore
  readonly config: MemoryEngineConfig
  private readonly distill: WorkspaceMemoryEngineOptions['distill']
  private readonly inFlightMessages = new Map<string, Set<string>>()

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
      surfacedPenalty: options.config?.surfacedPenalty ?? 8,
    }
  }

  async recall(input: RecallInput): Promise<MemoryContext> {
    const scope = this.store.scope(input.cwd)
    await this.store.ensure(scope)
    const global = this.store.scope('')
    await this.store.ensure(global)
    const [workspaceSnapshot, globalSnapshot] = await Promise.all([
      this.store.readSnapshot(scope),
      this.store.readSnapshot(global),
    ])
    const workspaceEntries = workspaceSnapshot.entries
    const globalEntries = globalSnapshot.entries
    const entries = scope.key === 'global' ? globalEntries : [...globalEntries, ...workspaceEntries]
    const summary = scope.key === 'global'
      ? globalSnapshot.summary
      : [globalSnapshot.summary, workspaceSnapshot.summary].filter(value => value.trim() !== '').join('\n\n')
    const matches = searchEntries(entries, input.query, {
      limit: input.limit ?? this.config.recallLimit,
      ...(input.surfacedMemoryIds === undefined ? {} : { surfacedMemoryIds: input.surfacedMemoryIds }),
      surfacedPenalty: this.config.surfacedPenalty,
    }).map(({ entry, score }) => ({
      id: entry.id,
      scope: entry.scope ?? 'workspace',
      title: entry.title ?? entry.content.slice(0, 80),
      description: entry.description ?? entry.content.slice(0, 240),
      type: entry.type ?? 'fact',
      content: redactSecrets(entry.content),
      tags: entry.tags ?? [],
      importance: entry.importance ?? 1,
      score,
      ...(entry.status === 'conflict' && entry.conflictGroupId === undefined ? { status: 'conflict' as const } : {}),
      ...(entry.status === 'conflict' && entry.conflictGroupId !== undefined
        ? {
            status: 'conflict' as const,
            conflictWith: entries
              .filter(candidate => candidate.id !== entry.id && candidate.conflictGroupId === entry.conflictGroupId && isRecallable(candidate))
              .map(candidate => candidate.id),
          }
        : {}),
    }))
    const budget = input.maxBytes ?? this.config.recallMaxBytes
    const boundedSummary = redactSecrets(truncateUtf8(summary, Math.min(budget, this.config.summaryMaxBytes)))
    let remaining = Math.max(0, budget - Buffer.byteLength(boundedSummary))
    const boundedMatches: MemoryMatch[] = []
    for (const match of matches) {
      const bytes = Buffer.byteLength(JSON.stringify(match))
      if (bytes > remaining) continue
      boundedMatches.push(match)
      remaining -= bytes
    }
    return {
      scope: scope.key,
      summary: boundedSummary,
      matches: boundedMatches,
    }
  }

  async checkpoint(input: CheckpointInput): Promise<CheckpointResult> {
    const scope = this.store.scope(input.cwd)
    const prepared = await this.store.withScope(scope, async () => {
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
        return { kind: 'result' as const, result: { status: 'empty' as const, scope: scope.key, accepted: 0, pending: 0, added: 0, updated: 0, ignored: 0 } }
      }
      const eligible = input.force === true || checkpointEligible(state, input.reason, this.config, this.store.now())
      if (!eligible) {
        await this.store.writeState(scope, state)
        return { kind: 'result' as const, result: { status: 'buffered' as const, scope: scope.key, accepted, pending: state.pendingMessages.length, added: 0, updated: 0, ignored: 0 } }
      }
      const claimed = this.inFlightMessages.get(scope.key) ?? new Set<string>()
      const available = state.pendingMessages.filter(message => !claimed.has(message.id))
      if (available.length === 0) {
        if (accepted > 0) await this.store.writeState(scope, state)
        return { kind: 'result' as const, result: { status: 'buffered' as const, scope: scope.key, accepted, pending: state.pendingMessages.length, added: 0, updated: 0, ignored: 0 } }
      }
      const staged: MemoryMessage[] = []
      let chars = 0
      for (const message of available) {
        if (chars >= this.config.checkpointMaxChars) break
        const available = this.config.checkpointMaxChars - chars
        const text = message.text.slice(0, available)
        staged.push({ ...message, text })
        chars += text.length
      }
      await this.store.writeState(scope, state)
      for (const message of staged) claimed.add(message.id)
      this.inFlightMessages.set(scope.key, claimed)
      return { kind: 'stage' as const, accepted, staged }
    })
    if (prepared.kind === 'result') return prepared.result

    const distillStartedAt = this.store.now()
    let operations: MemoryOperation[]
    try {
      const globalScope = this.store.scope('')
      const [workspaceEntries, globalEntries] = await Promise.all([
        this.store.readEntries(scope),
        scope.key === 'global' ? Promise.resolve([]) : this.store.readEntries(globalScope),
      ])
      const existingEntries = selectDistillationCandidates([...globalEntries, ...workspaceEntries], prepared.staged)
      const distilled = await this.distill({ scope, messages: prepared.staged, reason: input.reason, existingEntries })
      operations = normalizeOperations(distilled)
      debugMemory('distill-complete', { scope: scope.key, durationMs: Math.max(0, this.store.now() - distillStartedAt), messages: prepared.staged.length })
    } catch (error) {
      debugMemory('distill-error', { scope: scope.key, durationMs: Math.max(0, this.store.now() - distillStartedAt), error: String(error) })
      this.releaseClaims(scope, prepared.staged)
      const state = await this.store.withScope(scope, () => this.store.readState(scope))
      return {
        status: 'failed',
        scope: scope.key,
        accepted: prepared.accepted,
        pending: state.pendingMessages.length,
        added: 0,
        updated: 0,
        ignored: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    try {
      return await this.store.withScope(scope, async () => {
        await this.store.ensure(scope)
        const state = await this.store.readState(scope)
        const entries = await this.store.readEntries(scope)
        const nowIso = new Date(this.store.now()).toISOString()
        const workspaceOperations = scope.key === 'global'
          ? operations.map(operation => ({ ...operation, scope: 'global' as const, targetScope: 'global' as const }))
          : operations.filter(operation => operationScope(operation) === 'workspace').map(operation => ({ ...operation, scope: 'workspace' as const }))
        const globalOperations = scope.key === 'global'
          ? []
          : operations.filter(operation => operationScope(operation) === 'global').map(operation => ({ ...operation, scope: 'global' as const }))
        const result = applyOperations(entries, workspaceOperations, nowIso, this.store.uuid, prepared.staged)
        state.seenMessageIds = [...state.seenMessageIds, ...prepared.staged.map(message => message.id)].slice(-1024)
        const stagedIds = new Set(prepared.staged.map(message => message.id))
        state.pendingMessages = state.pendingMessages.filter(message => !stagedIds.has(message.id))
        state.lastCheckpointAt = this.store.now()
        state.checkpointCount += 1
        await this.store.writeEntries(scope, entries)
        let globalResult: AppliedOperations = { added: 0, updated: 0, ignored: 0, superseded: 0, conflicts: 0, audit: [] }
        if (globalOperations.length > 0 && scope.key !== 'global') {
          const globalScope = this.store.scope('')
          // Cross-scope mutations always acquire workspace before global. No reverse path is allowed.
          globalResult = await this.store.withScope(globalScope, async () => {
            await this.store.ensure(globalScope)
            const globalEntries = await this.store.readEntries(globalScope)
            const globalMutation = applyOperations(globalEntries, globalOperations, nowIso, this.store.uuid, prepared.staged)
            await this.store.writeEntries(globalScope, globalEntries)
            if (globalMutation.added + globalMutation.updated > 0 || !(await this.store.readSummary(globalScope)).trim()) {
              await this.store.rebuildSummary(globalScope, globalEntries, this.config.summaryMaxBytes, this.config.keepSummaryVersions)
            }
            return globalMutation
          })
        }
        if (result.added + result.updated > 0 || state.checkpointCount % this.config.consolidateEvery === 0 || !(await this.store.readSummary(scope)).trim()) {
          state.version += 1
          await this.store.rebuildSummary(scope, entries, this.config.summaryMaxBytes, this.config.keepSummaryVersions)
        }
        const combined: MutationResult = {
          added: result.added + globalResult.added,
          updated: result.updated + globalResult.updated,
          ignored: result.ignored + globalResult.ignored,
          superseded: (result.superseded ?? 0) + (globalResult.superseded ?? 0),
          conflicts: (result.conflicts ?? 0) + (globalResult.conflicts ?? 0),
        }
        await this.store.writeCheckpoint(scope, input.reason, prepared.staged, operations, combined, [...result.audit, ...globalResult.audit])
        await this.store.writeState(scope, state)
        return {
          status: 'committed' as const,
          scope: scope.key,
          accepted: prepared.accepted,
          pending: state.pendingMessages.length,
          ...combined,
        }
      })
    } finally {
      this.releaseClaims(scope, prepared.staged)
    }
  }

  private releaseClaims(scope: WorkspaceScope, messages: readonly MemoryMessage[]): void {
    const claimed = this.inFlightMessages.get(scope.key)
    if (claimed === undefined) return
    for (const message of messages) claimed.delete(message.id)
    if (claimed.size === 0) this.inFlightMessages.delete(scope.key)
  }

  async remember(input: RememberInput): Promise<{ scope: string } & MutationResult> {
    const scope = input.scope === 'global' ? this.store.scope('') : this.store.scope(input.cwd)
    return this.store.withScope(scope, async () => {
      await this.store.ensure(scope)
      const entries = await this.store.readEntries(scope)
      const proposal = normalizeProposal(input)
      if (proposal === undefined) throw new Error('memory content is empty or contains a credential-like secret')
      const result = applyOperations(entries, [{ ...proposal, op: 'add' }], new Date(this.store.now()).toISOString(), this.store.uuid)
      await this.store.writeEntries(scope, entries)
      await this.store.rebuildSummary(scope, entries, this.config.summaryMaxBytes, this.config.keepSummaryVersions)
      return { scope: scope.key, added: result.added, updated: result.updated, ignored: result.ignored }
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
