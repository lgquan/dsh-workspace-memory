import { useEffect, useMemo, useState } from 'react'
import { createElement as h } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

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
  checkpoints: '整理次数',
  updated: '最近更新',
  all: '全部',
  count: '条',
  active: '有效',
  conflict: '存在冲突',
  superseded: '已被取代',
  deleted: '已删除',
  revisions: '历史版本',
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
  checkpoints: 'Checkpoints',
  updated: 'Last updated',
  all: 'All',
  count: '',
  active: 'Active',
  conflict: 'Conflict',
  superseded: 'Superseded',
  deleted: 'Deleted',
  revisions: 'Previous revisions',
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
  state: { pending: number; checkpointCount: number; lastCheckpointAt: number }
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

function formatDate(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
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
    // Memory browsing is independent from the currently open session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const options = useMemo(() => {
    const known = new Map(scopes.map(scope => [scope.key, scope]))
    return [...known.values()]
  }, [scopes])

  const archivedOptions = useMemo(() => archivedScopes, [archivedScopes])

  const displayedPayload = view === 'active' ? payload : archivedPayload
  const displayedOptions = view === 'active' ? options : archivedOptions
  const displayedKey = view === 'active' ? selectedKey : archivedSelectedKey

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

  const colors = {
    text: 'var(--ds-color-text-primary, #f1f1f1)',
    secondary: 'var(--ds-color-text-secondary, #a7a7ad)',
    border: 'var(--ds-color-border, rgba(255,255,255,.12))',
    surface: 'var(--ds-color-bg-secondary, rgba(255,255,255,.045))',
    accent: 'var(--ds-color-primary, #8ab4ff)',
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
      h('label', { style: { color: colors.secondary, fontSize: 12 } }, t('scope')),
      h('select', {
        value: displayedKey, onChange: (event: Event) => { const key = (event.target as unknown as { value: string }).value; if (view === 'active') onSelect(key); else onSelectArchived(key) },
        style: { minHeight: 38, padding: '0 10px', color: colors.text, background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 6 },
      }, displayedOptions.length === 0
        ? h('option', { value: '' }, view === 'active' ? t('emptyScopes') : t('archiveEmpty'))
        : displayedOptions.map(scope => h('option', { key: scope.key, value: scope.key }, scope.kind === 'global' ? t('global') : workspaceName(scope.cwd, t('workspace')))),
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
        h('span', null, `${t('checkpoints')}: ${displayedPayload?.state.checkpointCount ?? 0}`),
      ),
      view === 'archived' && displayedPayload !== undefined && h('button', { type: 'button', onClick: () => { void purge() }, style: { justifySelf: 'start', color: '#ff8f8f', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, padding: '7px 11px', cursor: 'pointer' } }, t('purge')),
      h('article', { style: { border: `1px solid ${colors.border}`, borderRadius: 6, padding: 14, background: colors.surface } },
        h('h3', { style: { margin: '0 0 10px', fontSize: 14 } }, t('summary')),
        h('pre', { style: { margin: 0, color: colors.secondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word', font: 'inherit', lineHeight: 1.55 } }, displayedPayload?.summary.trim() || t('noSummary')),
      ),
      h('div', { style: { display: 'grid', gap: 10 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('h3', { style: { margin: 0, fontSize: 14 } }, `${t('entries')} (${filteredEntries.length})`),
          h('input', { type: 'search', value: query, placeholder: t('searchPlaceholder'), 'aria-label': t('search'), onChange: (event: Event) => { setQuery((event.target as unknown as { value: string }).value) }, style: { minHeight: 32, width: 230, maxWidth: '48%', padding: '0 9px', color: colors.text, background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6 } }),
        ),
        filteredEntries.length === 0 && h('p', { style: { color: colors.secondary, margin: 0 } }, t('noEntries')),
        filteredEntries.map(entry => h('details', { key: entry.id, style: { border: `1px solid ${colors.border}`, borderRadius: 6, padding: '10px 12px', background: colors.surface } },
          h('summary', { style: { cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline' } },
            h('strong', { style: { fontSize: 13 } }, entry.title),
            h('span', { style: { color: colors.secondary, fontSize: 11 } }, entry.type),
            h('span', { style: { color: entry.status === 'conflict' ? '#f4c96b' : entry.status === 'superseded' ? colors.secondary : colors.accent, fontSize: 11 } }, t(entry.status)),
          ),
          h('p', { style: { margin: '10px 0 0', color: colors.secondary, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, entry.content),
          entry.tags.length > 0 && h('div', { style: { marginTop: 10, color: colors.accent, fontSize: 11 } }, entry.tags.join(' · ')),
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
