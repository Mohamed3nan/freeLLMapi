import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/copy-button'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { ModelsTabs } from '@/components/models-tabs'
import { Tooltip } from '@/components/tooltip'

export interface FallbackEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  penalty: number
  rateLimitHits: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  monthlyTokenBudget: string
  monthlyTokenBudgetTokens?: number
  contextWindow?: number | null
  supportsVision: boolean
  supportsTools: boolean
  keyCount: number
  groupKey?: string
  canonicalId?: string
  groupLabel?: string
}

export type Row = FallbackEntry

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function groupMaxContext(members: Row[]): number {
  return Math.max(0, ...members.map(m => m.contextWindow ?? 0))
}

const CTX_BUCKETS: { key: number; label?: string; tKey?: string }[] = [
  { key: 0, tKey: 'ctxAny' },
  { key: 32_000, label: '32K+' },
  { key: 128_000, label: '128K+' },
  { key: 1_000_000, label: '1M+' },
]

export function RowContent({
  row,
  onToggle,
}: {
  row: Row
  rank?: number
  draggable?: boolean
  dragHandle?: any
  onToggle: (modelDbId: number, enabled: boolean) => void
}) {
  const { t } = useI18n()
  return (
    <>
      <td className="py-2.5 pl-4 pr-3 align-middle">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{row.displayName}</span>
          <span className="text-xs text-muted-foreground">{row.platform}</span>
          {row.supportsVision && (
            <span
              title={t('models.visionTitle')}
              className="text-[10px] rounded-full px-1.5 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400"
            >
              {t('models.vision')}
            </span>
          )}
          {row.supportsTools && (
            <span
              title={t('models.toolsTitle')}
              className="text-[10px] rounded-full px-1.5 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400"
            >
              {t('models.tools')}
            </span>
          )}
        </div>
      </td>
      <td className="py-2.5 pr-4 align-middle text-right">
        <Switch checked={row.enabled} onCheckedChange={(c) => onToggle(row.modelDbId, c)} />
      </td>
    </>
  )
}

export function ModelTableHead() {
  const { t } = useI18n()
  return (
    <thead>
      <tr className="text-left text-muted-foreground border-b">
        <th className="py-2.5 pl-4 pr-3 font-medium">{t('models.columnModel')}</th>
        <th className="py-2.5 pr-4 font-medium text-right">{t('models.columnOn')}</th>
      </tr>
    </thead>
  )
}

interface ModelGroupRow {
  key: string
  label: string
  members: Row[]
}

function buildGroups(rows: Row[]): ModelGroupRow[] {
  const map = new Map<string, Row[]>()
  for (const r of rows) {
    const key = r.groupKey ?? `solo:${r.modelDbId}`
    const arr = map.get(key)
    if (arr) arr.push(r)
    else map.set(key, [r])
  }
  return [...map.entries()].map(([key, members]) => ({
    key,
    label: members[0].groupLabel ?? members[0].displayName,
    members: [...members].sort((a, b) => a.priority - b.priority),
  }))
}

export default function FallbackPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)

  const [search, setSearch] = useState('')
  const [filterVision, setFilterVision] = useState(false)
  const [filterTools, setFilterTools] = useState(false)
  const [minContext, setMinContext] = useState(0)

  const [localDefault, setLocalDefault] = useState<string | null>(null)

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: defaultData } = useQuery<{ defaultModel: string }>({
    queryKey: ['fallback', 'default'],
    queryFn: () => apiFetch('/api/fallback/default'),
  })

  const saveMutation = useMutation({
    mutationFn: (body: { defaultModel?: string; models?: { modelDbId: number; priority: number; enabled: boolean }[] }) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'default'] })
      setLocalEntries(null)
      setLocalDefault(null)
    },
  })

  const allEntries = localEntries ?? entries
  const defaultModel = localDefault ?? defaultData?.defaultModel ?? ''
  const configured = allEntries.filter(e => e.keyCount > 0)
  const unconfiguredPlatforms = [...new Set(allEntries.filter(e => e.keyCount === 0).map(e => e.platform))]

  const rows: Row[] = configured

  function handleSave() {
    saveMutation.mutate({
      defaultModel: localDefault ?? undefined,
      models: allEntries.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled })),
    })
  }

  const hasChanges = localEntries !== null || localDefault !== null

  const rawGroups = buildGroups(rows)
  const orderedGroups = [...rawGroups].sort((a, b) => {
    const aIsDefault = a.members.some(m => m.canonicalId === defaultModel || m.modelId === defaultModel)
    const bIsDefault = b.members.some(m => m.canonicalId === defaultModel || m.modelId === defaultModel)
    if (aIsDefault) return -1
    if (bIsDefault) return 1
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  })

  const query = search.trim().toLowerCase()
  const filtersActive = query !== '' || filterVision || filterTools || minContext > 0
  const visibleGroups = orderedGroups.filter(g => {
    if (filterVision && !g.members.some(m => m.supportsVision)) return false
    if (filterTools && !g.members.some(m => m.supportsTools)) return false
    if (minContext > 0 && groupMaxContext(g.members) < minContext) return false
    if (query) {
      const hay = [
        g.label,
        g.members[0].canonicalId ?? '',
        ...g.members.map(m => m.platform),
        ...g.members.map(m => m.displayName),
        ...g.members.map(m => m.modelId),
      ].join(' ').toLowerCase()
      if (!hay.includes(query)) return false
    }
    return true
  })

  function clearFilters() {
    setSearch('')
    setFilterVision(false)
    setFilterTools(false)
    setMinContext(0)
  }

  function handleSingleToggle(modelDbId: number, enabled: boolean) {
    setLocalEntries(allEntries.map(e => (e.modelDbId === modelDbId ? { ...e, enabled } : e)))
  }

  function moveProviderInGroup(groupKey: string, index: number, dir: -1 | 1) {
    const group = orderedGroups.find(g => g.key === groupKey)
    if (!group) return
    const list = [...group.members]
    const j = index + dir
    if (j < 0 || j >= list.length) return

    const sortedPriorities = list.map(m => m.priority).sort((a, b) => a - b)
    ;[list[index], list[j]] = [list[j], list[index]]

    const newPriorityMap = new Map(list.map((m, idx) => [m.modelDbId, sortedPriorities[idx]]))

    setLocalEntries(allEntries.map(e => {
      if (newPriorityMap.has(e.modelDbId)) {
        return { ...e, priority: newPriorityMap.get(e.modelDbId)! }
      }
      return e
    }))
  }

  return (
    <div>
      <PageHeader
        title={t('models.title')}
        description={t('strategies.description')}
        divider={false}
        actions={<ModelsTabs />}
      />

      <div className="space-y-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : orderedGroups.length === 0 ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {t('models.noModelsBefore')}<a href="/keys" className="underline text-foreground">{t('models.keysPageLink')}</a>{t('models.noModelsAfter')}
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={t('models.searchPlaceholder')}
                  aria-label={t('models.searchPlaceholder')}
                  className="w-full rounded-xl border bg-card py-1.5 pl-9 pr-8 text-sm outline-none transition-colors focus:border-foreground/30"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    aria-label={t('models.clearSearch')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setFilterVision(v => !v)}
                  aria-pressed={filterVision}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${filterVision ? 'bg-foreground text-background border-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                >
                  {t('models.vision')}
                </button>
                <button
                  onClick={() => setFilterTools(v => !v)}
                  aria-pressed={filterTools}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${filterTools ? 'bg-foreground text-background border-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                >
                  {t('models.tools')}
                </button>
                <div className="inline-flex items-center gap-1 rounded-xl border p-1" role="group" aria-label={t('models.ctxTitle')}>
                  {CTX_BUCKETS.map(b => (
                    <button
                      key={b.key}
                      onClick={() => setMinContext(b.key)}
                      className={`px-2.5 py-1 text-xs rounded-lg transition-colors tabular-nums ${minContext === b.key ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                    >
                      {b.tKey ? t(`models.${b.tKey}`) : b.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filtersActive && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('models.showingCount', { shown: visibleGroups.length, total: orderedGroups.length })}</span>
                <button onClick={clearFilters} className="underline hover:text-foreground">{t('models.clearFilters')}</button>
              </div>
            )}

            {visibleGroups.length === 0 ? (
              <div className="rounded-3xl border border-dashed p-8 text-center">
                <p className="text-sm text-muted-foreground">{t('models.noMatches')}</p>
              </div>
            ) : (
              <div className="space-y-4">
                {visibleGroups.map(g => {
                  const vision = g.members.some(m => m.supportsVision)
                  const tools = g.members.some(m => m.supportsTools)
                  const maxCtx = groupMaxContext(g.members)
                  const detailId = encodeURIComponent(g.members[0].canonicalId ?? g.members[0].modelId)
                  const copyId = g.members[0].canonicalId ?? g.members[0].modelId
                  const isDefault = g.members[0].canonicalId === defaultModel || g.members[0].modelId === defaultModel
                  const anyEnabled = g.members.some(m => m.enabled)

                  return (
                    <section key={g.key} className={`rounded-3xl border bg-card p-5 transition-opacity ${anyEnabled ? '' : 'opacity-60'}`}>
                      <div className="flex items-baseline justify-between gap-4 mb-3 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          <Link to={`/models/chat/${detailId}`} className="text-sm font-semibold hover:underline min-w-0">
                            {g.label}
                          </Link>
                          {isDefault ? (
                            <span className="text-[10px] rounded-full px-2 py-0.5 bg-foreground text-background font-medium">
                              Default
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setLocalDefault(g.members[0].canonicalId ?? g.members[0].modelId)}
                              className="text-[11px] text-muted-foreground hover:text-foreground underline decoration-dotted underline-offset-2 transition-colors"
                            >
                              Make default
                            </button>
                          )}
                          {g.members.length > 1 && (
                            <Tooltip text={t('models.servedBy', { providers: g.members.map(m => m.platform).join(', ') })}>
                              <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground">{t('models.providerCount', { count: g.members.length })}</span>
                            </Tooltip>
                          )}
                          {maxCtx > 0 && (
                            <span title={t('models.ctxTitle')} className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground tabular-nums">
                              {t('models.ctxBadge', { size: formatContext(maxCtx) })}
                            </span>
                          )}
                          {vision && (
                            <span title={t('models.visionTitle')} className="text-[10px] rounded-full px-1.5 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">{t('models.vision')}</span>
                          )}
                          {tools && (
                            <span title={t('models.toolsTitle')} className="text-[10px] rounded-full px-1.5 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400">{t('models.tools')}</span>
                          )}
                          <CopyButton text={copyId} className="size-6" label={t('models.copyModelId')} />
                        </div>
                      </div>

                      <div className="divide-y border-t pt-1">
                        {g.members.map((m, i) => (
                          <div key={m.modelDbId} className={`flex items-center gap-3 py-2.5 ${m.enabled ? '' : 'opacity-50'}`}>
                            <span className="w-5 text-center font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium">{m.platform}</span>
                                <span className="truncate font-mono text-[11px] text-muted-foreground">{m.modelId}</span>
                                {m.keyCount === 0 && (
                                  <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-amber-600/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
                                    {t('models.noKey')}
                                  </span>
                                )}
                              </div>
                            </div>
                            {g.members.length > 1 && (
                              <div className="flex gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => moveProviderInGroup(g.key, i, -1)}
                                  disabled={i === 0}
                                  aria-label="Move up"
                                  className="rounded-md p-1 text-muted-foreground/60 hover:text-foreground disabled:opacity-25 transition-colors"
                                >
                                  <ArrowUp className="size-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => moveProviderInGroup(g.key, i, 1)}
                                  disabled={i === g.members.length - 1}
                                  aria-label="Move down"
                                  className="rounded-md p-1 text-muted-foreground/60 hover:text-foreground disabled:opacity-25 transition-colors"
                                >
                                  <ArrowDown className="size-3.5" />
                                </button>
                              </div>
                            )}
                            <Switch
                              checked={m.enabled}
                              onCheckedChange={(c) => handleSingleToggle(m.modelDbId, c)}
                            />
                          </div>
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>
            )}

            <FloatingBar show={hasChanges}>
              <span className="text-xs text-muted-foreground">{t('common.unsavedChanges')}</span>
              <Button variant="outline" size="sm" onClick={() => { setLocalEntries(null); setLocalDefault(null); }}>{t('common.discard')}</Button>
              <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? t('common.saving') : t('common.saveChanges')}
              </Button>
            </FloatingBar>

            {unconfiguredPlatforms.length > 0 && (
              <p className="text-xs text-muted-foreground">{t('models.hiddenNoKeys', { platforms: unconfiguredPlatforms.join(', ') })}</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
