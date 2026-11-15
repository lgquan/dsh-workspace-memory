import { useEffect, useMemo, useState } from 'react'
import { createElement as h } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { exactTokenUsage, formatCacheHitRate, formatTokenUsage } from './format.js'

const NS = 'workspace-memory'

const zh = {
  nav: '记忆',
  title: '记忆',
  refresh: '刷新',
  global: '全局记忆',
  workspace: '项目记忆',
  scope: '选择记忆范围',
  emptyScopes: '还没有已记录的项目记忆',
  summary: '摘要记忆',
  entries: '结构化记忆',
  search: '筛选记忆',
  searchPlaceholder: '搜索标题、内容或标签',
  noSummary: '暂无摘要',
  summaryUpdating: '摘要正在更新',
  summaryStartsIn: '预计约 {seconds} 秒后开始',
  summaryRunning: '模型正在生成摘要',
  summaryQueued: '正在等待可用的整理资源',
  summaryModelDuration: '模型生成通常还需几十秒',
  summaryTopics: '更新主题',
  summaryRecallAvailable: '更新期间，结构化记忆仍可正常检索',
  noEntries: '暂无结构化记忆',
  loading: '正在读取…',
  failed: '读取记忆失败',
  retry: '重试',
  activeView: '记忆',
  archiveView: '回收区',
  archiveEmpty: '回收区为空',
  purge: '永久删除',
  purgeConfirm: '确定永久删除这个项目的全部记忆吗？此操作无法撤销。',
  pending: '待整理',
  updated: '最近更新',
  all: '全部',
  count: '条',
  active: '有效',
  conflict: '存在冲突',
  superseded: '已被取代',
  deleted: '已删除',
  revisions: '历史版本',
  modelTitle: '记忆整理模型',
  modelUnavailable: '已选模型当前不可用',
  modelSaving: '正在保存',
  modelFailed: '模型设置读取或保存失败',
  processing: '后台状态',
  idle: '空闲',
  scheduled: '已计划',
  queued: '排队中',
  running: '整理中',
  retrying: '等待重试',
  blocked: '已暂停',
  nextRun: '下次运行',
  lastSuccess: '上次成功',
  lastError: '最近错误',
  todayTokenUsage: '今日整理',
  totalTokenUsage: '累计整理',
  cacheHitTokens: '缓存命中',
  cacheHitRate: '命中率',
  retryNow: '立即重试',
  edit: '编辑',
  delete: '删除',
  save: '保存',
  cancel: '取消',
  deleteConfirm: '确定删除这条记忆吗？删除后它将不再参与召回和摘要。',
  mutationFailed: '记忆更新或删除失败',
  titleLabel: '标题',
  descriptionLabel: '说明',
  contentLabel: '内容',
  tagsLabel: '标签',
  typeLabel: '类型',
  importanceLabel: '重要度',
  typePreference: '偏好（preference）',
  typeDecision: '决策（decision）',
  typeArchitecture: '架构（architecture）',
  typeRule: '规则（rule）',
  typeFact: '事实（fact）',
  typeFix: '修复（fix）',
}

const en = {
  nav: 'Memory',
  title: 'Memory',
  refresh: 'Refresh',
  global: 'Global memory',
  workspace: 'Project memory',
  scope: 'Memory scope',
  emptyScopes: 'No project memories recorded yet',
  summary: 'Summary memory',
  entries: 'Structured memory',
  search: 'Filter memory',
  searchPlaceholder: 'Search title, content, or tags',
  noSummary: 'No summary yet',
  summaryUpdating: 'Summary is updating',
  summaryStartsIn: 'Expected to start in about {seconds} seconds',
  summaryRunning: 'The model is generating the summary',
  summaryQueued: 'Waiting for available distillation capacity',
  summaryModelDuration: 'Model generation usually takes tens of seconds',
  summaryTopics: 'Updating topics',
  summaryRecallAvailable: 'Structured memories remain searchable during the update',
  noEntries: 'No structured memories yet',
  loading: 'Loading…',
  failed: 'Unable to read memory',
  retry: 'Retry',
  activeView: 'Memory',
  archiveView: 'Recycle bin',
  archiveEmpty: 'Recycle bin is empty',
  purge: 'Delete permanently',
  purgeConfirm: 'Permanently delete all memory for this project? This cannot be undone.',
  pending: 'Pending',
  updated: 'Last updated',
  all: 'All',
  count: '',
  active: 'Active',
  conflict: 'Conflict',
  superseded: 'Superseded',
  deleted: 'Deleted',
  revisions: 'Previous revisions',
  modelTitle: 'Memory distillation model',
  modelUnavailable: 'Selected model is currently unavailable',
  modelSaving: 'Saving',
  modelFailed: 'Unable to load or save model settings',
  processing: 'Background status',
  idle: 'Idle',
  scheduled: 'Scheduled',
  queued: 'Queued',
  running: 'Distilling',
  retrying: 'Waiting to retry',
  blocked: 'Paused',
  nextRun: 'Next run',
  lastSuccess: 'Last success',
  lastError: 'Last error',
  todayTokenUsage: 'Today',
  totalTokenUsage: 'Total',
  cacheHitTokens: 'Cache hit',
  cacheHitRate: 'Hit rate',
  retryNow: 'Retry now',
  edit: 'Edit',
  delete: 'Delete',
  save: 'Save',
  cancel: 'Cancel',
  deleteConfirm: 'Delete this memory? It will no longer appear in recall or summaries.',
  mutationFailed: 'Unable to update or delete memory',
  titleLabel: 'Title',
  descriptionLabel: 'Description',
  contentLabel: 'Content',
  tagsLabel: 'Tags',
  typeLabel: 'Type',
  importanceLabel: 'Importance',
  typePreference: 'Preference (preference)',
  typeDecision: 'Decision (decision)',
  typeArchitecture: 'Architecture (architecture)',
  typeRule: 'Rule (rule)',
  typeFact: 'Fact (fact)',
  typeFix: 'Fix (fix)',
}

type Translate = (key: keyof typeof zh) => string

interface ScopeInfo {
  key: string
  cwd: string
  kind: 'global' | 'workspace'
  entryCount: number
  hasSummary: boolean
  pending: number
  checkpointCount: number
  updatedAt?: string
  title?: string
  workspaceId?: string
  processing: ProcessingInfo
}

interface ProcessingInfo {
  phase: 'idle' | 'scheduled' | 'queued' | 'running' | 'retrying' | 'blocked'
  nextRunAt?: string
  runningSince?: string
  lastSuccessAt?: string
  lastError?: string
}

interface SummaryRefreshInfo {
  phase: 'idle' | 'scheduled' | 'queued' | 'running'
  nextRunAt?: string
  runningSince?: string
  topics: Array<{ id: string; title: string }>
}

interface DistillationStats {
  calls: number
  failures: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  todayDate: string
  todayTokens: number
  todayInputTokens: number
  todayCacheReadTokens: number
  todayCacheWriteTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  consecutiveFailures: number
  blocked: boolean
  lastCallAt?: number
  lastFinishReason?: string
  lastError?: string
  lastErrorCode?: string
}

interface MemoryEntry {
  id: string
  scope: string
  type: string
  title: string
  description: string
  content: string
  tags: string[]
  importance: number
  createdAt?: string
  updatedAt?: string
  status: 'active' | 'conflict' | 'superseded' | 'deleted'
  conflictGroupId?: string
  supersedes?: string[]
  supersededBy?: string[]
  revisions?: Array<{ content: string; title: string; description: string; at: string }>
}

interface ScopePayload {
  scope: { key: string; cwd: string; kind: 'global' | 'workspace' }
  summary: string
  entries: MemoryEntry[]
  state: { pending: number; checkpointCount: number; lastCheckpointAt: number; processing: ProcessingInfo; summaryRefresh: SummaryRefreshInfo; distillation: DistillationStats }
}

interface ModelSettings {
  selection: { provider: string; model: string }
  available: boolean
  writable: boolean
  catalog: {
    groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string }> }>
    failures: Array<{ id: string; name: string; message: string }>
  }
}

interface EditDraft {
  id: string
  title: string
  description: string
  content: string
  tags: string
  type: string
  importance: number
}

const memoryTypes = ['preference', 'decision', 'architecture', 'rule', 'fact', 'fix'] as const
type MemoryType = typeof memoryTypes[number]

const memoryTypeKeys: Record<MemoryType, keyof typeof zh> = {
  preference: 'typePreference',
  decision: 'typeDecision',
  architecture: 'typeArchitecture',
  rule: 'typeRule',
  fact: 'typeFact',
  fix: 'typeFix',
}

function memoryTypeLabel(t: Translate, type: string): string {
  return memoryTypes.includes(type as MemoryType) ? t(memoryTypeKeys[type as MemoryType]) : type
}

type MemoryView = 'active' | 'archived'

interface SlotsLike {
  inject(slot: string, register: () => unknown): void
  register(options: Record<string, unknown>, component: () => unknown): unknown
}

interface LocaleLike {
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): (key: string) => string
}

interface MemoryClientContext {
  effect(callback: () => unknown, label?: string): void
  slots: SlotsLike
  locale: LocaleLike
}

function workspaceName(cwd: string, fallback: string): string {
  const normalized = cwd.replaceAll('\\', '/').replace(/\/+$/u, '')
  const name = normalized.split('/').filter(Boolean).at(-1)
  return name ?? fallback
}

function workspaceLabel(scope: ScopeInfo, scopes: readonly ScopeInfo[], fallback: string): string {
  if (scope.kind === 'global') return fallback
  const base = scope.title?.trim() || workspaceName(scope.cwd, fallback)
  const duplicates = scopes.filter(candidate => candidate.kind === 'workspace'
    && (candidate.title?.trim() || workspaceName(candidate.cwd, fallback)) === base)
  return duplicates.length > 1 ? `${base} — ${scope.cwd}` : base
}

function modelValue(selection: ModelSettings['selection'] | undefined): string {
  return selection === undefined ? '' : JSON.stringify([selection.provider, selection.model])
}

function formatDate(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

function tokenUsageRow(
  t: Translate,
  label: string,
  totalTokens: number,
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): ReturnType<typeof h> {
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
  return h('div', { style: { display: 'flex', gap: '6px 16px', flexWrap: 'wrap', alignItems: 'baseline' } },
    h('span', { title: exactTokenUsage(totalTokens) }, `${label}: ${formatTokenUsage(totalTokens)}`),
    h('span', { title: `${exactTokenUsage(cacheReadTokens)} / ${exactTokenUsage(promptTokens)}` }, `${t('cacheHitTokens')}: ${formatTokenUsage(cacheReadTokens)}`),
    h('span', null, `${t('cacheHitRate')}: ${formatCacheHitRate(cacheReadTokens, inputTokens, cacheWriteTokens)}`),
  )
}

function iconRefresh(): ReturnType<typeof h> {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
    h('path', { d: 'M13 4.8A5.5 5.5 0 1 0 13.5 9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
    h('path', { d: 'M10.8 2.8h2.8v2.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  )
}

function MemorySection({ t }: { t: Translate } & Partial<SettingsSectionOwnerProps>) {
  const [scopes, setScopes] = useState<ScopeInfo[]>([])
  const [selectedKey, setSelectedKey] = useState('global')
  const [payload, setPayload] = useState<ScopePayload | undefined>()
  const [archivedScopes, setArchivedScopes] = useState<ScopeInfo[]>([])
  const [archivedSelectedKey, setArchivedSelectedKey] = useState('')
  const [archivedPayload, setArchivedPayload] = useState<ScopePayload | undefined>()
  const [view, setView] = useState<MemoryView>('active')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [modelSettings, setModelSettings] = useState<ModelSettings>()
  const [modelSaving, setModelSaving] = useState(false)
  const [modelError, setModelError] = useState(false)
  const [editDraft, setEditDraft] = useState<EditDraft>()
  const [mutating, setMutating] = useState(false)
  const [mutationError, setMutationError] = useState(false)

  const loadScopes = async (): Promise<ScopeInfo[]> => {
    const response = await fetch('/workspace-memory/api/v1/scopes')
    if (!response.ok) throw new Error(`scope list failed (${response.status})`)
    const result = await response.json() as { scopes?: ScopeInfo[] }
    return Array.isArray(result.scopes) ? result.scopes : []
  }

  const loadScope = async (cwd: string): Promise<ScopePayload> => {
    const response = await fetch(`/workspace-memory/api/v1/scope?cwd=${encodeURIComponent(cwd)}`)
    if (!response.ok) throw new Error(`scope read failed (${response.status})`)
    return await response.json() as ScopePayload
  }

  const loadArchivedScopes = async (): Promise<ScopeInfo[]> => {
    const response = await fetch('/workspace-memory/api/v1/archived-scopes')
    if (!response.ok) throw new Error(`archived scope list failed (${response.status})`)
    const result = await response.json() as { scopes?: ScopeInfo[] }
    return Array.isArray(result.scopes) ? result.scopes : []
  }

  const loadArchivedScope = async (key: string): Promise<ScopePayload> => {
    const response = await fetch(`/workspace-memory/api/v1/archived-scope?key=${encodeURIComponent(key)}`)
    if (!response.ok) throw new Error(`archived scope read failed (${response.status})`)
    return await response.json() as ScopePayload
  }

  const loadModelSettings = async (): Promise<ModelSettings> => {
    const response = await fetch('/workspace-memory/api/v1/settings')
    if (!response.ok) throw new Error(`memory settings read failed (${response.status})`)
    return await response.json() as ModelSettings
  }

  const reload = async (cwd?: string): Promise<void> => {
    setLoading(true)
    setError(false)
    try {
      const nextScopes = await loadScopes()
      setScopes(nextScopes)
      const next = await loadScope(cwd ?? payload?.scope.cwd ?? '')
      setPayload(next)
      setSelectedKey(next.scope.key)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  const reloadArchived = async (key?: string): Promise<void> => {
    setLoading(true)
    setError(false)
    try {
      const nextScopes = await loadArchivedScopes()
      setArchivedScopes(nextScopes)
      const nextKey = key ?? (archivedSelectedKey !== '' ? archivedSelectedKey : nextScopes[0]?.key) ?? ''
      if (nextKey === '') {
        setArchivedSelectedKey('')
        setArchivedPayload(undefined)
      } else {
        const next = await loadArchivedScope(nextKey)
        setArchivedSelectedKey(next.scope.key)
        setArchivedPayload(next)
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    void loadModelSettings().then(settings => {
      setModelSettings(settings)
      setModelError(false)
    }, () => setModelError(true))
    // Memory browsing is independent from the currently open session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      void loadScopes().then(nextScopes => {
        setScopes(nextScopes)
        const current = nextScopes.find(scope => scope.key === selectedKey)
        if (current !== undefined) void loadScope(current.cwd).then(setPayload, () => {})
      }, () => {})
    }, 5000)
    return () => globalThis.clearInterval(timer)
    // Workspace titles and background state can change while this page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  const options = useMemo(() => {
    const known = new Map(scopes.map(scope => [scope.key, scope]))
    return [...known.values()]
  }, [scopes])

  const archivedOptions = useMemo(() => archivedScopes, [archivedScopes])

  const displayedPayload = view === 'active' ? payload : archivedPayload
  const displayedOptions = view === 'active' ? options : archivedOptions
  const displayedKey = view === 'active' ? selectedKey : archivedSelectedKey
  const selectedModelValue = modelValue(modelSettings?.selection)
  const unavailableSelection = modelSettings !== undefined && modelSettings.available === false
    ? modelSettings.selection
    : undefined
  const summaryRefresh = view === 'active' ? displayedPayload?.state.summaryRefresh : undefined
  const summaryRefreshActive = summaryRefresh !== undefined && summaryRefresh.phase !== 'idle' && summaryRefresh.topics.length > 0
  const summaryWaitSeconds = summaryRefresh?.nextRunAt === undefined
    ? undefined
    : Math.max(1, Math.ceil((Date.parse(summaryRefresh.nextRunAt) - Date.now()) / 1000))

  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (normalized === '') return displayedPayload?.entries ?? []
    return (displayedPayload?.entries ?? []).filter(entry => [entry.title, entry.description, entry.content, ...entry.tags]
      .join(' ').toLocaleLowerCase().includes(normalized))
  }, [displayedPayload, query])

  const onSelect = (key: string): void => {
    const option = options.find(scope => scope.key === key)
    if (option === undefined) return
    setSelectedKey(key)
    void reload(option.cwd)
  }

  const onSelectArchived = (key: string): void => {
    if (!archivedOptions.some(scope => scope.key === key)) return
    setArchivedSelectedKey(key)
    void reloadArchived(key)
  }

  const showArchived = (): void => {
    setView('archived')
    if (archivedPayload === undefined) void reloadArchived()
  }

  const purge = async (): Promise<void> => {
    const confirm = (globalThis as unknown as { confirm?: (message: string) => boolean }).confirm
    if (archivedSelectedKey === '' || (confirm !== undefined && !confirm(t('purgeConfirm')))) return
    setLoading(true)
    setError(false)
    try {
      const response = await fetch(`/workspace-memory/api/v1/archived-scope?key=${encodeURIComponent(archivedSelectedKey)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`archived scope delete failed (${response.status})`)
      await reloadArchived()
    } catch {
      setError(true)
      setLoading(false)
    }
  }

  const saveModel = async (value: string): Promise<void> => {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return
    const [provider, model] = parsed
    setModelSaving(true)
    setModelError(false)
    try {
      const response = await fetch('/workspace-memory/api/v1/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, model }),
      })
      if (!response.ok) throw new Error(`memory settings write failed (${response.status})`)
      setModelSettings(await response.json() as ModelSettings)
    } catch {
      setModelError(true)
    } finally {
      setModelSaving(false)
    }
  }

  const beginEdit = (entry: MemoryEntry): void => {
    setMutationError(false)
    setEditDraft({
      id: entry.id,
      title: entry.title,
      description: entry.description,
      content: entry.content,
      tags: entry.tags.join(', '),
      type: entry.type,
      importance: entry.importance,
    })
  }

  const saveEntry = async (): Promise<void> => {
    if (editDraft === undefined || displayedPayload === undefined || view !== 'active') return
    setMutating(true)
    setMutationError(false)
    try {
      const query = new URLSearchParams({ cwd: displayedPayload.scope.cwd, id: editDraft.id })
      const response = await fetch(`/workspace-memory/api/v1/entry?${query.toString()}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: editDraft.title,
          description: editDraft.description,
          content: editDraft.content,
          tags: editDraft.tags.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean),
          type: editDraft.type,
          importance: editDraft.importance,
        }),
      })
      if (!response.ok) throw new Error(`memory update failed (${response.status})`)
      setEditDraft(undefined)
      await reload(displayedPayload.scope.cwd)
    } catch {
      setMutationError(true)
    } finally {
      setMutating(false)
    }
  }

  const deleteEntry = async (entry: MemoryEntry): Promise<void> => {
    if (displayedPayload === undefined || view !== 'active') return
    const confirm = (globalThis as unknown as { confirm?: (message: string) => boolean }).confirm
    if (confirm !== undefined && !confirm(t('deleteConfirm'))) return
    setMutating(true)
    setMutationError(false)
    try {
      const query = new URLSearchParams({ cwd: displayedPayload.scope.cwd, id: entry.id })
      const response = await fetch(`/workspace-memory/api/v1/entry?${query.toString()}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(`memory delete failed (${response.status})`)
      if (editDraft?.id === entry.id) setEditDraft(undefined)
      await reload(displayedPayload.scope.cwd)
    } catch {
      setMutationError(true)
    } finally {
      setMutating(false)
    }
  }

  const retryDistillation = async (): Promise<void> => {
    if (displayedPayload === undefined || view !== 'active') return
    setMutating(true)
    setMutationError(false)
    try {
      const query = new URLSearchParams({ cwd: displayedPayload.scope.cwd })
      const response = await fetch(`/workspace-memory/api/v1/retry?${query.toString()}`, { method: 'POST' })
      if (!response.ok) throw new Error(`memory retry failed (${response.status})`)
      await reload(displayedPayload.scope.cwd)
    } catch {
      setMutationError(true)
    } finally {
      setMutating(false)
    }
  }

  const colors = {
    text: 'var(--dsw-alias-label-primary, #1f2328)',
    secondary: 'var(--dsw-alias-label-secondary, #6b7280)',
    tertiary: 'var(--dsw-alias-label-tertiary, #8b93a1)',
    border: 'var(--dsw-alias-border-l2, #e5e7eb)',
    surface: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
    elevated: 'var(--dsw-alias-bg-layer-3, #ffffff)',
    accent: 'var(--dsw-alias-brand-primary, #4f6ef7)',
    primaryFill: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary, #1f2328))',
    onPrimary: 'var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-3, #fff))',
    warning: 'var(--dsw-alias-state-warn-primary, #b45309)',
    danger: 'var(--dsw-alias-state-error-primary, #dc2626)',
  }

  return h('section', { style: { color: colors.text, maxWidth: 820, paddingBottom: 24 } },
    h('header', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 18 } },
      h('div', null,
        h('h2', { style: { margin: 0, fontSize: 20, fontWeight: 650 } }, t('title')),
        h('p', { style: { margin: '6px 0 0', color: colors.secondary, fontSize: 12, wordBreak: 'break-all' } }, displayedPayload?.scope.cwd || t('global')),
      ),
      h('button', {
        type: 'button', title: t('refresh'), 'aria-label': t('refresh'), onClick: () => { void (view === 'active' ? reload() : reloadArchived()) },
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, border: `1px solid ${colors.border}`, borderRadius: 6, background: 'transparent', color: colors.text, cursor: 'pointer' },
      }, iconRefresh()),
    ),
    h('div', { style: { display: 'flex', gap: 6, marginBottom: 16 } },
      h('button', { type: 'button', onClick: () => setView('active'), 'aria-pressed': view === 'active', style: { padding: '7px 11px', border: `1px solid ${colors.border}`, borderRadius: 6, background: view === 'active' ? colors.surface : 'transparent', color: colors.text, cursor: 'pointer' } }, t('activeView')),
      h('button', { type: 'button', onClick: showArchived, 'aria-pressed': view === 'archived', style: { padding: '7px 11px', border: `1px solid ${colors.border}`, borderRadius: 6, background: view === 'archived' ? colors.surface : 'transparent', color: colors.text, cursor: 'pointer' } }, t('archiveView')),
    ),
    h('div', { style: { display: 'grid', gap: 8, marginBottom: 18 } },
      h('label', { style: { color: colors.secondary, fontSize: 12 } }, t('modelTitle')),
      h('select', {
        value: selectedModelValue,
        disabled: modelSaving || modelSettings === undefined || modelSettings.writable === false,
        onChange: (event: Event) => { void saveModel((event.target as unknown as { value: string }).value) },
        style: { boxSizing: 'border-box', minHeight: 38, width: '100%', padding: '0 10px', color: colors.text, background: colors.elevated, border: `1px solid ${modelSettings?.available === false ? colors.warning : colors.border}`, borderRadius: 8, colorScheme: 'light dark', font: 'inherit' },
      },
      unavailableSelection !== undefined && h('option', {
        value: selectedModelValue,
        style: { color: colors.text, background: colors.elevated },
      }, `${unavailableSelection.provider} / ${unavailableSelection.model} (${t('modelUnavailable')})`),
      ...(modelSettings?.catalog.groups ?? []).map(group => h('optgroup', { key: group.id, label: group.name },
        group.models.map(model => h('option', { key: `${group.id}:${model.id}`, value: JSON.stringify([group.id, model.id]), style: { color: colors.text, background: colors.elevated } }, model.name)),
      ))),
      modelSaving && h('span', { style: { color: colors.secondary, fontSize: 12 } }, t('modelSaving')),
      modelSettings?.available === false && h('span', { role: 'alert', style: { color: colors.warning, fontSize: 12 } }, t('modelUnavailable')),
      modelError && h('span', { role: 'alert', style: { color: colors.danger, fontSize: 12 } }, t('modelFailed')),
    ),
    h('div', { style: { display: 'grid', gap: 8, marginBottom: 18 } },
      h('label', { style: { color: colors.secondary, fontSize: 12 } }, t('scope')),
      h('select', {
        value: displayedKey,
        onChange: (event: Event) => { const key = (event.target as unknown as { value: string }).value; if (view === 'active') onSelect(key); else onSelectArchived(key) },
        style: { boxSizing: 'border-box', minHeight: 38, width: '100%', padding: '0 10px', color: colors.text, background: colors.elevated, border: `1px solid ${colors.border}`, borderRadius: 8, colorScheme: 'light dark', font: 'inherit' },
      }, displayedOptions.length === 0
        ? h('option', { value: '', style: { color: colors.text, background: colors.elevated } }, view === 'active' ? t('emptyScopes') : t('archiveEmpty'))
        : displayedOptions.map(scope => h('option', { key: scope.key, value: scope.key, style: { color: colors.text, background: colors.elevated } }, scope.kind === 'global' ? t('global') : workspaceLabel(scope, displayedOptions, t('workspace')))),
      ),
    ),
    error && h('div', { role: 'alert', style: { padding: 12, border: `1px solid ${colors.border}`, borderRadius: 6, color: colors.secondary, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 } },
      h('span', null, t('failed')),
      h('button', { type: 'button', onClick: () => { void (view === 'active' ? reload() : reloadArchived()) }, style: { color: colors.accent, background: 'transparent', border: 0, cursor: 'pointer' } }, t('retry')),
    ),
    loading && h('p', { style: { color: colors.secondary } }, t('loading')),
    !loading && !error && h('div', { style: { display: 'grid', gap: 16 } },
      h('div', { style: { display: 'flex', gap: 16, color: colors.secondary, fontSize: 12, flexWrap: 'wrap' } },
        h('span', null, `${displayedPayload?.entries.length ?? 0}${t('count')}`),
        h('span', null, `${t('pending')}: ${displayedPayload?.state.pending ?? 0}`),
        h('span', null, `${t('processing')}: ${t(displayedPayload?.state.processing.phase ?? 'idle')}`),
        displayedPayload?.state.processing.nextRunAt !== undefined && h('span', null, `${t('nextRun')}: ${formatDate(displayedPayload.state.processing.nextRunAt)}`),
        displayedPayload?.state.processing.lastSuccessAt !== undefined && h('span', null, `${t('lastSuccess')}: ${formatDate(displayedPayload.state.processing.lastSuccessAt)}`),
      ),
      view === 'active' && displayedPayload?.scope.kind === 'workspace' && h('div', {
        style: { display: 'grid', gap: 5, color: colors.secondary, fontSize: 12 },
      },
      tokenUsageRow(
        t,
        t('todayTokenUsage'),
        displayedPayload.state.distillation.todayTokens,
        displayedPayload.state.distillation.todayInputTokens,
        displayedPayload.state.distillation.todayCacheReadTokens,
        displayedPayload.state.distillation.todayCacheWriteTokens,
      ),
      tokenUsageRow(
        t,
        t('totalTokenUsage'),
        displayedPayload.state.distillation.totalTokens,
        displayedPayload.state.distillation.inputTokens,
        displayedPayload.state.distillation.cacheReadTokens,
        displayedPayload.state.distillation.cacheWriteTokens,
      )),
      displayedPayload?.state.processing.lastError !== undefined && h('div', { role: 'alert', style: { color: colors.warning, fontSize: 12, overflowWrap: 'anywhere' } }, `${t('lastError')}: ${displayedPayload.state.processing.lastError}`),
      view === 'active' && displayedPayload?.state.processing.phase === 'blocked' && h('button', {
        type: 'button', disabled: mutating, onClick: () => { void retryDistillation() },
        style: { justifySelf: 'start', color: colors.text, background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 6, padding: '7px 11px', cursor: 'pointer' },
      }, t('retryNow')),
      mutationError && h('div', { role: 'alert', style: { color: colors.danger, fontSize: 12 } }, t('mutationFailed')),
      view === 'archived' && displayedPayload !== undefined && h('button', { type: 'button', onClick: () => { void purge() }, style: { justifySelf: 'start', color: colors.danger, background: 'transparent', border: `1px solid ${colors.danger}`, borderRadius: 8, padding: '7px 11px', cursor: 'pointer' } }, t('purge')),
      h('article', { style: { border: `1px solid ${colors.border}`, borderRadius: 6, padding: 14, background: colors.surface } },
        h('h3', { style: { margin: '0 0 10px', fontSize: 14 } }, t('summary')),
        summaryRefreshActive && h('div', { role: 'status', style: { display: 'grid', gap: 5, marginBottom: 12, padding: '9px 10px', borderLeft: `3px solid ${colors.accent}`, background: colors.elevated, color: colors.secondary, fontSize: 12, lineHeight: 1.5 } },
          h('strong', { style: { color: colors.text, fontSize: 13 } }, t('summaryUpdating')),
          h('span', null,
            summaryRefresh.phase === 'scheduled' && summaryWaitSeconds !== undefined
              ? `${t('summaryStartsIn').replace('{seconds}', String(summaryWaitSeconds))}；${t('summaryModelDuration')}`
              : summaryRefresh.phase === 'running'
                ? `${t('summaryRunning')}；${t('summaryModelDuration')}`
                : `${t('summaryQueued')}；${t('summaryModelDuration')}`,
          ),
          h('span', null, `${t('summaryTopics')}：${summaryRefresh.topics.map(topic => topic.title).join('、')}`),
          h('span', null, t('summaryRecallAvailable')),
        ),
        h('pre', { style: { margin: 0, color: colors.secondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word', font: 'inherit', lineHeight: 1.55 } }, displayedPayload?.summary.trim() || t('noSummary')),
      ),
      h('div', { style: { display: 'grid', gap: 10 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('h3', { style: { margin: 0, fontSize: 14 } }, `${t('entries')} (${filteredEntries.length})`),
          h('input', { type: 'search', value: query, placeholder: t('searchPlaceholder'), 'aria-label': t('search'), onChange: (event: Event) => { setQuery((event.target as unknown as { value: string }).value) }, style: { minHeight: 32, width: 230, maxWidth: '48%', padding: '0 9px', color: colors.text, background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6 } }),
        ),
        filteredEntries.length === 0 && h('p', { style: { color: colors.secondary, margin: 0 } }, t('noEntries')),
        filteredEntries.map(entry => h('details', { key: entry.id, open: editDraft?.id === entry.id ? true : undefined, style: { border: `1px solid ${colors.border}`, borderRadius: 6, padding: '10px 12px', background: colors.surface } },
          h('summary', { style: { cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline' } },
            h('strong', { style: { fontSize: 13 } }, entry.title),
            h('span', { style: { color: colors.tertiary, fontSize: 11 } }, memoryTypeLabel(t, entry.type)),
            h('span', { style: { color: entry.status === 'conflict' ? colors.warning : entry.status === 'superseded' ? colors.tertiary : colors.accent, fontSize: 11 } }, t(entry.status)),
          ),
          editDraft?.id === entry.id
            ? h('div', { style: { display: 'grid', gap: 10, marginTop: 12 } },
                h('label', { style: { display: 'grid', gap: 5, color: colors.secondary, fontSize: 11 } }, t('titleLabel'),
                  h('input', { value: editDraft.title, onChange: (event: Event) => setEditDraft({ ...editDraft, title: (event.target as unknown as { value: string }).value }), style: { boxSizing: 'border-box', width: '100%', minHeight: 34, padding: '0 9px', color: colors.text, background: colors.elevated, border: `1px solid ${colors.border}`, borderRadius: 6 } }),
                ),
                h('label', { style: { display: 'grid', gap: 5, color: colors.secondary, fontSize: 11 } }, t('descriptionLabel'),
                  h('input', { value: editDraft.description, onChange: (event: Event) => setEditDraft({ ...editDraft, description: (event.target as unknown as { value: string }).value }), style: { boxSizing: 'border-box', width: '100%', minHeight: 34, padding: '0 9px', color: colors.text, background: colors.elevated, border: `1px solid ${colors.border}`, borderRadius: 6 } }),
                ),
                h('label', { style: { display: 'grid', gap: 5, color: colors.secondary, fontSize: 11 } }, t('contentLabel'),
                  h('textarea', { value: editDraft.content, rows: 5, onChange: (event: Event) => setEditDraft({ ...editDraft, content: (event.target as unknown as { value: string }).value }), style: { boxSizing: 'border-box', width: '100%', resize: 'vertical', minHeight: 110, padding: 9, color: colors.text, background: colors.elevated, border: `1px solid ${colors.border}`, borderRadius: 6, font: 'inherit', lineHeight: 1.5 } }),
                ),
                h('label', { style: { display: 'grid', gap: 5, color: colors.secondary, fontSize: 11 } }, t('tagsLabel'),
                  h('input', { value: editDraft.tags, onChange: (event: Event) => setEditDraft({ ...editDraft, tags: (event.target as unknown as { value: string }).value }), style: { boxSizing: 'border-box', width: '100%', minHeight: 34, padding: '0 9px', color: colors.text, background: colors.elevated, border: `1px solid ${colors.border}`, borderRadius: 6 } }),
                ),
                h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10 } },
                  h('label', { style: { display: 'grid', gap: 5, color: colors.secondary, fontSize: 11 } }, t('typeLabel'),
                    h('select', { value: editDraft.type, onChange: (event: Event) => setEditDraft({ ...editDraft, type: (event.target as unknown as { value: string }).value }), style: { boxSizing: 'border-box', width: '100%', minHeight: 34, padding: '0 9px', color: colors.text, background: colors.elevated, border: `1px solid ${colors.border}`, borderRadius: 6 } },
                      memoryTypes.map(type => h('option', { key: type, value: type }, memoryTypeLabel(t, type))),
                    ),
                  ),
                  h('label', { style: { display: 'grid', gap: 5, color: colors.secondary, fontSize: 11 } }, t('importanceLabel'),
                    h('select', { value: String(editDraft.importance), onChange: (event: Event) => setEditDraft({ ...editDraft, importance: Number((event.target as unknown as { value: string }).value) }), style: { boxSizing: 'border-box', width: '100%', minHeight: 34, padding: '0 9px', color: colors.text, background: colors.elevated, border: `1px solid ${colors.border}`, borderRadius: 6 } },
                      [0, 1, 2, 3].map(value => h('option', { key: value, value: String(value) }, String(value))),
                    ),
                  ),
                ),
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('button', { type: 'button', disabled: mutating, onClick: () => { void saveEntry() }, style: { padding: '7px 11px', color: colors.onPrimary, background: colors.primaryFill, border: 0, borderRadius: 6, cursor: 'pointer' } }, t('save')),
                  h('button', { type: 'button', disabled: mutating, onClick: () => setEditDraft(undefined), style: { padding: '7px 11px', color: colors.text, background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer' } }, t('cancel')),
                ),
              )
            : h('p', { style: { margin: '10px 0 0', color: colors.secondary, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, entry.content),
          editDraft?.id !== entry.id && entry.tags.length > 0 && h('div', { style: { marginTop: 10, color: colors.accent, fontSize: 11 } }, entry.tags.join(' · ')),
          view === 'active' && editDraft?.id !== entry.id && h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            entry.status === 'active' && h('button', { type: 'button', disabled: mutating, onClick: () => beginEdit(entry), style: { padding: '6px 10px', color: colors.accent, background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer' } }, t('edit')),
            h('button', { type: 'button', disabled: mutating, onClick: () => { void deleteEntry(entry) }, style: { padding: '6px 10px', color: colors.danger, background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer' } }, t('delete')),
          ),
          (entry.revisions?.length ?? 0) > 0 && h('details', { style: { marginTop: 10, color: colors.secondary, fontSize: 11 } },
            h('summary', { style: { cursor: 'pointer' } }, `${t('revisions')} (${entry.revisions?.length ?? 0})`),
            entry.revisions?.map(revision => h('p', { key: `${revision.at}:${revision.content}`, style: { margin: '6px 0 0', whiteSpace: 'pre-wrap' } }, revision.content)),
          ),
          entry.updatedAt !== undefined && h('div', { style: { marginTop: 8, color: colors.secondary, fontSize: 11 } }, `${t('updated')}: ${formatDate(entry.updatedAt)}`),
        )),
      ),
    ),
  )
}

export const inject = ['slots', 'locale']

export function apply(ctx: MemoryClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workspace-memory: dictionaries')
  const translate = ctx.locale.bind(NS)
  const t = (key: keyof typeof zh): string => {
    const translated = translate(key)
    return translated || zh[key]
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'workspace-memory',
    order: 50,
    label: () => t('nav'),
    locale: NS,
  }, () => h(MemorySection, { t })))
}
