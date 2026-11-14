import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const REPRESENTATIONS_DIR = 'representations'
export const REPRESENTATION_META_FILE = 'representation_meta.json'

export type MemoryTopicId =
  | 'user-profile'
  | 'preferences'
  | 'project-overview'
  | 'architecture'
  | 'decisions'
  | 'conventions'
  | 'fixes-and-pitfalls'

export interface RepresentationEntry {
  id: string
  scope?: 'global' | 'workspace'
  type?: 'preference' | 'decision' | 'architecture' | 'rule' | 'fact' | 'fix'
  title?: string
  description?: string
  content: string
  tags?: string[]
  importance?: number
  status?: 'active' | 'conflict' | 'superseded' | 'deleted'
  updatedAt?: string
}

export interface TopicSource {
  id: MemoryTopicId
  title: string
  sourceHash: string
  entries: RepresentationEntry[]
}

export interface RepresentationManifest {
  version: 2
  generationId: string
  sourceHash: string
  createdAt: number
  fullRefreshAt: number
  summaryMaxBytes: number
  topics: Partial<Record<MemoryTopicId, {
    title: string
    sourceHash: string
    sourceIds: string[]
  }>>
}

export type RepresentationPreparation =
  | { status: 'clean'; manifest?: RepresentationManifest }
  | {
      status: 'ready'
      sourceHash: string
      dirtyTopics: TopicSource[]
      allTopics: TopicSource[]
      fullRefresh: boolean
    }

export interface GeneratedTopic {
  id: MemoryTopicId
  content: string
  sourceIds: string[]
}

export interface PublishedRepresentation {
  summary: string
  index: string
  topics: Partial<Record<MemoryTopicId, string>>
  manifest?: RepresentationManifest
}

interface RepresentationStoreOptions {
  now: () => number
  uuid: () => string
  writeAtomic: (file: string, text: string) => Promise<void>
}

export const MEMORY_TOPICS: ReadonlyArray<{ id: MemoryTopicId; title: string }> = [
  { id: 'user-profile', title: '用户画像' },
  { id: 'preferences', title: '偏好' },
  { id: 'project-overview', title: '项目概览' },
  { id: 'architecture', title: '架构' },
  { id: 'decisions', title: '决策' },
  { id: 'conventions', title: '规范与规则' },
  { id: 'fixes-and-pitfalls', title: '修复经验与注意事项' },
]

const TOPIC_IDS = new Set<MemoryTopicId>(MEMORY_TOPICS.map(topic => topic.id))

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function topicForEntry(scopeKey: string, entry: RepresentationEntry): MemoryTopicId {
  if (entry.type === 'preference') return 'preferences'
  if (entry.type === 'architecture') return 'architecture'
  if (entry.type === 'decision') return 'decisions'
  if (entry.type === 'rule') return 'conventions'
  if (entry.type === 'fix') return 'fixes-and-pitfalls'
  return scopeKey === 'global' ? 'user-profile' : 'project-overview'
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function activeEntries(entries: readonly RepresentationEntry[]): RepresentationEntry[] {
  return entries.filter(entry => (entry.status ?? 'active') === 'active')
}

export function representationSourceHash(entries: readonly RepresentationEntry[]): string {
  return hash(activeEntries(entries).map(entry => ({
    id: entry.id,
    type: entry.type,
    title: entry.title,
    description: entry.description,
    content: entry.content,
    tags: entry.tags,
    importance: entry.importance,
    updatedAt: entry.updatedAt,
  })).sort((left, right) => left.id.localeCompare(right.id)))
}

export function representationTopicSources(scopeKey: string, entries: readonly RepresentationEntry[]): TopicSource[] {
  const grouped = new Map<MemoryTopicId, RepresentationEntry[]>()
  for (const entry of activeEntries(entries)) {
    const topicId = topicForEntry(scopeKey, entry)
    const group = grouped.get(topicId) ?? []
    group.push(entry)
    grouped.set(topicId, group)
  }
  return MEMORY_TOPICS.map(topic => {
    const source = (grouped.get(topic.id) ?? []).sort((left, right) =>
      Number(right.importance ?? 1) - Number(left.importance ?? 1)
      || String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
      || left.id.localeCompare(right.id))
    return {
      ...topic,
      sourceHash: hash(source.map(entry => ({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        content: entry.content,
        tags: entry.tags,
        importance: entry.importance,
        updatedAt: entry.updatedAt,
      }))),
      entries: source,
    }
  })
}

function parseManifest(raw: string): RepresentationManifest | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.version !== 2 || typeof value.generationId !== 'string'
      || typeof value.sourceHash !== 'string' || typeof value.createdAt !== 'number'
      || typeof value.fullRefreshAt !== 'number' || !isRecord(value.topics)) return undefined
    const topics: RepresentationManifest['topics'] = {}
    for (const [id, topic] of Object.entries(value.topics)) {
      if (!TOPIC_IDS.has(id as MemoryTopicId) || !isRecord(topic) || typeof topic.title !== 'string'
        || typeof topic.sourceHash !== 'string' || !Array.isArray(topic.sourceIds)
        || !topic.sourceIds.every(sourceId => typeof sourceId === 'string')) continue
      topics[id as MemoryTopicId] = {
        title: topic.title,
        sourceHash: topic.sourceHash,
        sourceIds: [...topic.sourceIds],
      }
    }
    return {
      version: 2,
      generationId: value.generationId,
      sourceHash: value.sourceHash,
      createdAt: value.createdAt,
      fullRefreshAt: value.fullRefreshAt,
      summaryMaxBytes: typeof value.summaryMaxBytes === 'number' ? value.summaryMaxBytes : 3_000,
      topics,
    }
  } catch {
    return undefined
  }
}

function topicFile(scopeDir: string, manifest: RepresentationManifest, id: MemoryTopicId): string {
  return join(scopeDir, REPRESENTATIONS_DIR, 'generations', manifest.generationId, 'topics', `${id}.md`)
}

function normalizeTopicContent(content: string, title: string): string {
  const lines = content.trim().replace(/^```(?:markdown|md)?\s*/iu, '').replace(/\s*```$/u, '').trim().split(/\r?\n/u)
  const body = lines.filter((line, index) => !(index === 0 && /^#{1,6}\s/u.test(line))).join('\n').trim()
  if (body === '') throw new Error(`semantic topic ${title} is empty`)
  return `## ${title}\n\n${truncateUtf8(body, 2_000)}\n`
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  let result = ''
  for (const character of text) {
    if (Buffer.byteLength(result + character) > Math.max(0, maxBytes - 3)) break
    result += character
  }
  return `${result.trimEnd()}...`
}

function topicDescription(content: string): string {
  const line = content.split(/\r?\n/u).map(value => value.trim()).find(value => value !== '' && !value.startsWith('#')) ?? '已整理的长期记忆'
  return truncateUtf8(line.replace(/^[-*]\s+/u, '').replace(/^\*{1,2}|\*{1,2}$/gu, ''), 180)
}

function renderSummary(scopeKey: string, topics: PublishedRepresentation['topics'], maxBytes: number): string {
  if (Object.keys(topics).length === 0) return ''
  const lines = [scopeKey === 'global' ? '# 全局记忆' : '# 项目记忆', '', '由 dsh-workspace-memory 根据结构化记忆生成的语义摘要。', '']
  for (const topic of MEMORY_TOPICS) {
    const content = topics[topic.id]
    if (content === undefined) continue
    const candidate = [...lines, content.trim(), ''].join('\n')
    if (Buffer.byteLength(candidate) > maxBytes) continue
    lines.push(content.trim(), '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

function renderIndex(scopeKey: string, topics: PublishedRepresentation['topics'], maxBytes: number): string {
  if (Object.keys(topics).length === 0) return ''
  const lines = [scopeKey === 'global' ? '# 全局记忆索引' : '# 项目记忆索引', '']
  for (const topic of MEMORY_TOPICS) {
    const content = topics[topic.id]
    if (content === undefined) continue
    const line = `- ${topic.title}（${topic.id}）：${topicDescription(content)}`
    if (Buffer.byteLength([...lines, line, ''].join('\n')) > maxBytes) break
    lines.push(line)
  }
  return lines.join('\n').trimEnd() + '\n'
}

function currentTopics(
  scopeDir: string,
  scopeKey: string,
  entries: readonly RepresentationEntry[],
  manifest: RepresentationManifest | undefined,
  read: (file: string) => string,
): PublishedRepresentation['topics'] {
  if (manifest === undefined) return {}
  const sources = new Map(representationTopicSources(scopeKey, entries).map(source => [source.id, source]))
  const topics: PublishedRepresentation['topics'] = {}
  for (const topic of MEMORY_TOPICS) {
    const metadata = manifest.topics[topic.id]
    const source = sources.get(topic.id)
    if (metadata === undefined || source === undefined || source.entries.length === 0 || metadata.sourceHash !== source.sourceHash) continue
    const content = read(topicFile(scopeDir, manifest, topic.id)).trim()
    if (content !== '') topics[topic.id] = content + '\n'
  }
  return topics
}

export class MemoryRepresentations {
  constructor(private readonly options: RepresentationStoreOptions) {}

  async readManifest(scopeDir: string): Promise<RepresentationManifest | undefined> {
    return parseManifest(await readFile(join(scopeDir, REPRESENTATION_META_FILE), 'utf8').catch(() => ''))
  }

  readIndexSync(scopeDir: string, scopeKey: string, entries: readonly RepresentationEntry[], maxBytes: number): string {
    return readRepresentationIndexSync(scopeDir, scopeKey, entries, maxBytes)
  }

  async read(scopeDir: string, scopeKey: string, entries: readonly RepresentationEntry[], maxBytes: number): Promise<PublishedRepresentation> {
    const manifest = await this.readManifest(scopeDir)
    const topics = currentTopics(scopeDir, scopeKey, entries, manifest, file => {
      try { return readFileSync(file, 'utf8') } catch { return '' }
    })
    return {
      summary: renderSummary(scopeKey, topics, Math.min(maxBytes, manifest?.summaryMaxBytes ?? maxBytes)),
      index: renderIndex(scopeKey, topics, Math.min(maxBytes, 3_000)),
      topics,
      ...(manifest === undefined ? {} : { manifest }),
    }
  }

  async readTopic(scopeDir: string, scopeKey: string, entries: readonly RepresentationEntry[], id: MemoryTopicId): Promise<string> {
    return (await this.read(scopeDir, scopeKey, entries, Number.MAX_SAFE_INTEGER)).topics[id] ?? ''
  }

  async prepare(
    scopeDir: string,
    scopeKey: string,
    entries: readonly RepresentationEntry[],
    fullRefreshIntervalMs: number,
  ): Promise<RepresentationPreparation> {
    const manifest = await this.readManifest(scopeDir)
    const allTopics = representationTopicSources(scopeKey, entries)
    const periodicRefresh = manifest !== undefined && manifest.fullRefreshAt + Math.max(0, fullRefreshIntervalMs) <= this.options.now()
    const dirtyTopics = allTopics.filter(topic => {
      const current = manifest?.topics[topic.id]
      if (topic.entries.length === 0) return current !== undefined
      return periodicRefresh || current?.sourceHash !== topic.sourceHash || !existsSync(topicFile(scopeDir, manifest as RepresentationManifest, topic.id))
    })
    if (manifest !== undefined && dirtyTopics.length === 0) return { status: 'clean', manifest }
    return {
      status: 'ready',
      sourceHash: representationSourceHash(entries),
      dirtyTopics,
      allTopics,
      fullRefresh: manifest === undefined || periodicRefresh,
    }
  }

  async commit(
    scopeDir: string,
    scopeKey: string,
    entries: readonly RepresentationEntry[],
    preparation: Exclude<RepresentationPreparation, { status: 'clean' }>,
    generatedTopics: readonly GeneratedTopic[],
    maxBytes: number,
    keepGenerations: number,
  ): Promise<boolean> {
    if (representationSourceHash(entries) !== preparation.sourceHash) return false
    const currentSources = representationTopicSources(scopeKey, entries)
    if (currentSources.some((source, index) => source.sourceHash !== preparation.allTopics[index]?.sourceHash)) return false
    const generated = new Map(generatedTopics.map(topic => [topic.id, topic]))
    const dirtyIds = new Set(preparation.dirtyTopics.filter(topic => topic.entries.length > 0).map(topic => topic.id))
    if (generated.size !== dirtyIds.size || [...generated.keys()].some(id => !dirtyIds.has(id))) return false

    const current = await this.read(scopeDir, scopeKey, entries, maxBytes)
    const topics: PublishedRepresentation['topics'] = { ...current.topics }
    for (const dirty of preparation.dirtyTopics) {
      if (dirty.entries.length === 0) {
        delete topics[dirty.id]
        continue
      }
      const generatedTopic = generated.get(dirty.id)
      const activeIds = new Set(dirty.entries.map(entry => entry.id))
      if (generatedTopic === undefined || generatedTopic.sourceIds.length === 0
        || generatedTopic.sourceIds.some(id => !activeIds.has(id))) return false
      topics[dirty.id] = normalizeTopicContent(generatedTopic.content, dirty.title)
    }

    const generationId = `${String(this.options.now())}-${this.options.uuid()}`
    const generationDir = join(scopeDir, REPRESENTATIONS_DIR, 'generations', generationId)
    await mkdir(join(generationDir, 'topics'), { recursive: true })
    for (const topic of MEMORY_TOPICS) {
      const content = topics[topic.id]
      if (content !== undefined) await this.options.writeAtomic(join(generationDir, 'topics', `${topic.id}.md`), content)
    }
    const summary = renderSummary(scopeKey, topics, maxBytes)
    const index = renderIndex(scopeKey, topics, Math.min(maxBytes, 3_000))
    await this.options.writeAtomic(join(generationDir, 'memory_summary.md'), summary)
    await this.options.writeAtomic(join(generationDir, 'memory_index.md'), index)

    const previous = await this.readManifest(scopeDir)
    const topicMetadata: RepresentationManifest['topics'] = {}
    for (const source of currentSources) {
      if (source.entries.length === 0 || topics[source.id] === undefined) continue
      const generatedTopic = generated.get(source.id)
      const sourceIds = generatedTopic?.sourceIds ?? previous?.topics[source.id]?.sourceIds ?? []
      if (sourceIds.length === 0) return false
      topicMetadata[source.id] = {
        title: source.title,
        sourceHash: source.sourceHash,
        sourceIds,
      }
    }
    const now = this.options.now()
    const manifest: RepresentationManifest = {
      version: 2,
      generationId,
      sourceHash: preparation.sourceHash,
      createdAt: now,
      fullRefreshAt: preparation.fullRefresh ? now : previous?.fullRefreshAt ?? now,
      summaryMaxBytes: maxBytes,
      topics: topicMetadata,
    }
    await this.options.writeAtomic(join(scopeDir, REPRESENTATION_META_FILE), JSON.stringify(manifest, null, 2) + '\n')

    const generationsDir = join(scopeDir, REPRESENTATIONS_DIR, 'generations')
    const generations = (await readdir(generationsDir, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse()
    for (const stale of generations.slice(Math.max(1, keepGenerations))) {
      await rm(join(generationsDir, stale), { recursive: true, force: true }).catch(() => {})
    }
    return true
  }
}

export function readRepresentationIndexSync(
  scopeDir: string,
  scopeKey: string,
  entries: readonly RepresentationEntry[],
  maxBytes: number,
): string {
  let raw = ''
  try { raw = readFileSync(join(scopeDir, REPRESENTATION_META_FILE), 'utf8') } catch {}
  const manifest = parseManifest(raw)
  const topics = currentTopics(scopeDir, scopeKey, entries, manifest, file => {
    try { return readFileSync(file, 'utf8') } catch { return '' }
  })
  return renderIndex(scopeKey, topics, maxBytes)
}
