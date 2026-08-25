import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ContextMenu from './ContextMenu'
import FailureDialog from './FailureDialog'
import RemoveWorkflowDialog from './RemoveWorkflowDialog'
import StopWorkflowDialog from './StopWorkflowDialog'
import type { SessionStatus } from '../App'
import { failureOf, formatCost, normalizePath, type Failure } from '@renderer/format'
import { repoColor } from '@renderer/repoColor'
import { useGitAction } from '@renderer/useGitAction'
import { useGitColors } from '@renderer/useGitColors'
import { useUsage } from '@renderer/useUsage'
import { agentSummary, type AgentSession, type AgentSummary } from '@renderer/useAgents'
import {
  inboxSignal,
  inScope,
  isRegistered,
  parkedBadge,
  parkedTitle,
  repoScope,
  reviewTitle,
  staleTitle,
  stateLabel,
  stateSlug,
  usable,
  needsOperator,
  type InboxSignal,
  type WorkflowEntry,
  type WorkflowRepo,
  type WorkflowResult
} from '@renderer/workflowText'

type Overview = Awaited<ReturnType<typeof window.api.workflow.overview>>
type Targeted = { repo: WorkflowRepo; entry: WorkflowEntry }
type WorkflowMenu = Targeted & { x: number; y: number }
type Activity = {
  status?: SessionStatus
  title?: string
  agents: AgentSession[]
  summary: AgentSummary
}
type WorkflowRow = {
  entry: WorkflowEntry
  activity: Activity
  cost: number
  dir: string | undefined
  order: number
  signal: InboxSignal
}
type OpenSession = {
  id: number
  dir?: string
  label: string
  status?: SessionStatus
  title?: string
  terminalIds: number[]
}
type SessionRow = {
  session: OpenSession
  activity: Activity
  cost: number
  signal: InboxSignal
}
type RepoDrag = {
  repo: string
  target: string
  after: boolean
}

const narrowWorkspaceQuery = '(max-width: 1200px)'

interface WorkflowManagerProps {
  active: boolean
  onLaunch: (dir: string, repo: string) => void
  onSelectSession: (id: number) => void
  onCloseSession: (id: number) => void
  onOpenDiff: (cwd: string, branch: string) => void
  onCloseWorktree?: (dir: string) => void
  sessionStatuses: Record<string, SessionStatus>
  sessionTitles: Record<string, string>
  agentSessions: AgentSession[]
  openSessions: OpenSession[]
  workspaceOrder: string[]
  onWorkspaceOrderChange: typeof window.api.snowconfig.setWorkspaceOrder
}

function openDir(repo: WorkflowRepo, entry: WorkflowEntry): string | undefined {
  if (usable(entry) && entry.worktree) return entry.worktree
  if (entry.current) return repo.repo
  return undefined
}

function directoryKey(dir: string): string {
  const normalized = normalizePath(dir)
  return navigator.platform.startsWith('Win') ? normalized.toLowerCase() : normalized
}

function orderRepos(repos: WorkflowRepo[], order: string[]): WorkflowRepo[] {
  const positions = new Map<string, number>()
  for (const [index, repo] of order.entries()) {
    const key = directoryKey(repo)
    if (!positions.has(key)) positions.set(key, index)
  }
  return repos
    .map((repo, index) => ({ repo, index, position: positions.get(directoryKey(repo.repo)) }))
    .sort(
      (left, right) =>
        (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index
    )
    .map(({ repo }) => repo)
}

const emptyActivity: Activity = {
  agents: [],
  summary: { waiting: 0, working: 0, names: [] }
}

function signalTitle(signal: InboxSignal, activity: Activity): string {
  const names = activity.summary.names
  const who = names.length > 1 ? `${signal.label} (${names.join(', ')})` : signal.label
  return activity.title ? `${who}\n${activity.title}` : who
}

function activitySignal(activity: Activity): InboxSignal {
  const { waiting, working } = activity.summary
  if (waiting > 0) {
    return {
      tier: 4,
      label: `${waiting === 1 ? 'needs input' : `${waiting} need input`}${
        working > 0 ? ` · ${working} working` : ''
      }`,
      slug: 'input'
    }
  }
  if (working > 0 || activity.status === 'busy') {
    return {
      tier: 2,
      label: working > 1 ? `${working} working` : 'working',
      slug: 'working'
    }
  }
  if (activity.status === 'attention') return { tier: 3, label: 'finished', slug: 'finished' }
  return { tier: 0, label: '', slug: '' }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

function WorkflowManager({
  active,
  onLaunch,
  onSelectSession,
  onCloseSession,
  onOpenDiff,
  onCloseWorktree,
  sessionStatuses,
  sessionTitles,
  agentSessions,
  openSessions,
  workspaceOrder,
  onWorkspaceOrderChange
}: WorkflowManagerProps): React.JSX.Element {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [removing, setRemoving] = useState<Targeted | null>(null)
  const [demoting, setDemoting] = useState<Targeted | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [repoDrag, setRepoDrag] = useState<RepoDrag | null>(null)
  const [workflowMenu, setWorkflowMenu] = useState<WorkflowMenu | null>(null)
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia(narrowWorkspaceQuery).matches)
  const lanes = useGitColors()?.lanes
  const usage = useUsage()
  const overviewRef = useRef<Overview | null>(null)
  const watchedDirsRef = useRef(new Map<string, string>())
  useEffect(() => {
    overviewRef.current = overview
  }, [overview])

  useEffect(() => {
    const media = window.matchMedia(narrowWorkspaceQuery)
    const update = (): void => setIsNarrow(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  /**
   * The manager summarizes worktrees that may not have an open shell, Git panel, or diff view of
   * their own. Watch those directories here so an agent's ordinary file writes refresh the review
   * count instead of leaving the overview stuck on its last Git snapshot.
   *
   * Only while the screen is showing. These watchers cover directories nothing else in the app has
   * open, so leaving them attached means several agents writing files in parallel worktrees each
   * broadcast `git:changed` on their own debounce, and every one of those re-runs the detailed
   * overview below - the exact fan-out this screen exists to survive, paid for a hidden tab.
   */
  useEffect(() => {
    // Hidden, nothing is wanted, so the unwatch pass below tears every watcher down.
    const repos = active ? (overview?.repos ?? []) : []
    const wanted = new Map<string, string>()
    for (const repo of repos) {
      for (const entry of repo.workflows) {
        const dir = openDir(repo, entry)
        if (!dir) continue
        const normalized = normalizePath(dir)
        const key = navigator.platform.startsWith('Win') ? normalized.toLowerCase() : normalized
        wanted.set(key, dir)
      }
    }

    for (const [key, dir] of watchedDirsRef.current) {
      if (!wanted.has(key)) window.api.git.unwatch(dir)
    }
    for (const [key, dir] of wanted) {
      if (!watchedDirsRef.current.has(key)) void window.api.git.watch(dir)
    }
    watchedDirsRef.current = wanted
  }, [overview, active])

  useEffect(
    () => () => {
      for (const dir of watchedDirsRef.current.values()) window.api.git.unwatch(dir)
      watchedDirsRef.current.clear()
    },
    []
  )

  const action = useGitAction<WorkflowResult>({
    onFailure: setFailure,
    onSettled: () => setRefreshKey((key) => key + 1)
  })

  /**
   * A detailed overview is a `git status` and a `rev-list` per workspace on top of the four fixed
   * reads per repo, so it is only worth paying for while someone is looking at it. Re-subscribing
   * on activation reloads as a side effect, which is what keeps a screen that was hidden through a
   * burst of agent activity from coming back stale. The last overview stays rendered meanwhile, so
   * reopening the tab shows the previous rows rather than "Loading…" while the reload lands.
   */
  useEffect(() => {
    if (!active) return

    let stopped = false
    let running = false
    let queued = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = async (): Promise<void> => {
      if (running) {
        queued = true
        return
      }
      running = true
      try {
        do {
          queued = false
          const result = await window.api.workflow.overview(true)
          if (stopped) return
          setOverview(result)
        } while (queued)
      } finally {
        running = false
      }
    }

    const scheduleLoad = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void load()
      }, 100)
    }

    void load()
    // A repo's linked worktrees live outside its root but share its stash, so they count as in
    // scope too - without them a commit in a parallel session never refreshes this screen.
    const offGit = window.api.git.onChanged((changedCwd) => {
      const hit = overviewRef.current?.repos.some((repo) =>
        inScope(changedCwd, repoScope(repo.repo, repo.workflows))
      )
      if (hit) scheduleLoad()
    })
    const offWorkflow = window.api.workflow.onChanged(scheduleLoad)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      offGit()
      offWorkflow()
    }
  }, [active, refreshKey])

  const workflowDirectories = useMemo(
    () =>
      new Set(
        (overview?.repos ?? []).flatMap((repo) =>
          repo.workflows.flatMap((entry) => {
            const dir = openDir(repo, entry)
            return dir ? [directoryKey(dir)] : []
          })
        )
      ),
    [overview]
  )
  const nonaffiliatedSessions = useMemo(
    () =>
      openSessions.filter((session) => {
        if (!session.dir) return true
        const dir = directoryKey(session.dir)
        for (const workflowDir of workflowDirectories) {
          if (dir === workflowDir || dir.startsWith(`${workflowDir}/`)) return false
        }
        return true
      }),
    [openSessions, workflowDirectories]
  )

  /**
   * Index every status, agent, and cost sample into its owning workspace in one pass. Walking a
   * sample's ancestors preserves subtree accounting without rescanning the whole sample set for
   * every rendered row.
   */
  const indexedRows = useMemo(() => {
    type Indexed = {
      agents: AgentSession[]
      tabSelected: { path: string; status: SessionStatus } | null
      cost: number
    }
    const indexed = new Map<string, Indexed>()
    if (!active) return new Map<string, { activity: Activity; cost: number }>()
    for (const repo of overview?.repos ?? []) {
      for (const entry of repo.workflows) {
        const dir = openDir(repo, entry)
        if (dir) indexed.set(directoryKey(dir), { agents: [], tabSelected: null, cost: 0 })
      }
    }
    for (const session of nonaffiliatedSessions) {
      if (session.dir && !indexed.has(directoryKey(session.dir))) {
        indexed.set(directoryKey(session.dir), { agents: [], tabSelected: null, cost: 0 })
      }
    }

    const visitOwners = (raw: string, visit: (row: Indexed) => void): void => {
      let key = directoryKey(raw)
      while (key) {
        const row = indexed.get(key)
        if (row) visit(row)
        const slash = key.lastIndexOf('/')
        if (slash < 0) break
        const parent = key.slice(0, slash)
        if (!parent || parent === key) break
        key = parent
      }
    }

    for (const session of agentSessions) {
      if (session.state === 'idle' || !session.cwd) continue
      visitOwners(session.cwd, (row) => row.agents.push(session))
    }

    const rank: Record<SessionStatus, number> = { attention: 2, busy: 1, idle: 0 }
    for (const [path, status] of Object.entries(sessionStatuses)) {
      visitOwners(path, (row) => {
        if (!row.tabSelected || rank[status] > rank[row.tabSelected.status]) {
          row.tabSelected = { path, status }
        }
      })
    }

    for (const [path, cost] of Object.entries(usage?.byDirectory ?? {})) {
      visitOwners(path, (row) => {
        row.cost += cost
      })
    }

    const result = new Map<string, { activity: Activity; cost: number }>()
    for (const [key, row] of indexed) {
      const summary = agentSummary(row.agents)
      const tabTitle = row.tabSelected ? sessionTitles[row.tabSelected.path] : undefined
      let activity: Activity
      if (!row.agents.length) {
        activity = row.tabSelected
          ? {
              status: row.tabSelected.status,
              title: row.tabSelected.status === 'idle' ? undefined : tabTitle,
              agents: row.agents,
              summary
            }
          : { agents: row.agents, summary }
      } else {
        const detail = row.agents
          .map((session) => session.detail)
          .filter(Boolean)
          .join('\n')
        activity = {
          status: summary.waiting ? 'attention' : 'busy',
          title: tabTitle || detail,
          agents: row.agents,
          summary
        }
      }
      result.set(key, { activity, cost: row.cost })
    }
    return result
  }, [
    active,
    overview,
    agentSessions,
    sessionStatuses,
    sessionTitles,
    usage,
    nonaffiliatedSessions
  ])

  const indexedFor = (dir: string): { activity: Activity; cost: number } =>
    indexedRows.get(directoryKey(dir)) ?? { activity: emptyActivity, cost: 0 }

  const sessionRows = useMemo<SessionRow[]>(() => {
    const agentsByTerminal = new Map<number, AgentSession[]>()
    for (const agent of agentSessions) {
      if (agent.state === 'idle' || agent.terminalId == null) continue
      const current = agentsByTerminal.get(agent.terminalId) ?? []
      current.push(agent)
      agentsByTerminal.set(agent.terminalId, current)
    }

    return nonaffiliatedSessions
      .map((session): SessionRow => {
        const agents = session.terminalIds.flatMap(
          (terminalId) => agentsByTerminal.get(terminalId) ?? []
        )
        const summary = agentSummary(agents)
        const status = summary.waiting ? 'attention' : summary.working ? 'busy' : session.status
        const detail = agents
          .map((agent) => agent.detail)
          .filter(Boolean)
          .join('\n')
        const activity: Activity = {
          status,
          title: status === 'idle' ? undefined : session.title || detail || undefined,
          agents,
          summary
        }
        return {
          session,
          activity,
          cost: session.dir ? (indexedRows.get(directoryKey(session.dir))?.cost ?? 0) : 0,
          signal: activitySignal(activity)
        }
      })
      .sort(
        (left, right) =>
          right.signal.tier - left.signal.tier ||
          right.cost - left.cost ||
          left.session.id - right.session.id
      )
  }, [agentSessions, nonaffiliatedSessions, indexedRows])

  const launchOne = async (repo: WorkflowRepo, entry: WorkflowEntry): Promise<Failure | null> => {
    if (usable(entry) && entry.worktree) {
      onLaunch(entry.worktree, repo.repo)
      return null
    }
    if (entry.worktree) return { title: staleTitle(entry), detail: entry.worktree }
    if (entry.current) {
      onLaunch(repo.repo, repo.repo)
      return null
    }
    if (!entry.exists)
      return {
        title: `Branch ${entry.branch} no longer exists`,
        detail: entry.parked ? 'Its parked changes are still stashed.' : ''
      }

    const result = await window.api.workflow.promote(repo.repo, entry.branch)
    if (!result.ok) return failureOf(result)
    if (result.worktree) onLaunch(result.worktree, repo.repo)
    return null
  }

  const launch = (repo: WorkflowRepo, entry: WorkflowEntry): void => {
    if (action.pending) return
    action.run(async () => {
      const failed = await launchOne(repo, entry)
      return failed ? { ok: false, error: failed.title, detail: failed.detail } : { ok: true }
    }, 'Opening workspace…')
  }

  const launchAll = (repo: WorkflowRepo): void => {
    if (action.pending || repo.workflows.length === 0) return
    action.run(async () => {
      const failed: string[] = []
      for (const entry of repo.workflows) {
        const problem = await launchOne(repo, entry)
        if (problem)
          failed.push(
            `${entry.branch}: ${problem.title}${problem.detail ? `\n${indent(problem.detail)}` : ''}`
          )
      }
      if (failed.length === 0) return { ok: true }
      return {
        ok: false,
        error: `Launched ${repo.workflows.length - failed.length} of ${repo.workflows.length} workflows in ${repo.name}`,
        detail: failed.join('\n\n')
      }
    }, `Opening ${repo.name} workspaces…`)
  }

  const create = (repo: WorkflowRepo, e: React.FormEvent): void => {
    e.preventDefault()
    const name = (drafts[repo.repo] ?? '').trim()
    if (!name || action.pending) return
    setDrafts((prev) => ({ ...prev, [repo.repo]: '' }))
    action.run(async () => {
      const result = await window.api.workflow.create(repo.repo, name)
      if (result.worktree) onLaunch(result.worktree, repo.repo)
      return result
    }, 'Creating…')
  }

  const register = (repo: WorkflowRepo): void => {
    if (action.pending) return
    action.run(() => window.api.workflow.register(repo.repo), 'Registering…')
  }

  const prune = (repo: WorkflowRepo): void => {
    if (action.pending) return
    action.run(() => window.api.workflow.prune(repo.repo), 'Pruning…')
  }

  const unregister = (): void => {
    const target = removing
    setRemoving(null)
    if (!target || action.pending) return
    action.run(
      () => window.api.workflow.unregister(target.repo.repo, target.entry.branch),
      'Removing…'
    )
  }

  const demote = (): void => {
    const target = demoting
    setDemoting(null)
    if (!target || action.pending) return
    action.run(async () => {
      const result = await window.api.workflow.demote(target.repo.repo, target.entry.branch)
      if (result.worktree) onCloseWorktree?.(result.worktree)
      return result
    }, 'Removing workspace…')
  }

  const orderedRepos = orderRepos(overview?.repos ?? [], workspaceOrder)

  const saveRepoOrder = (next: string[]): void => {
    void onWorkspaceOrderChange(next).then((result) => {
      if (!result.error) return
      setFailure({
        title: 'Could not save workspace order',
        detail: `${result.path}\n${result.error}`
      })
    })
  }

  const moveRepo = (repo: string, target: string, after: boolean): void => {
    if (directoryKey(repo) === directoryKey(target)) return
    const current = orderedRepos.map((entry) => entry.repo)
    const next = current.filter((entry) => directoryKey(entry) !== directoryKey(repo))
    const targetIndex = next.findIndex((entry) => directoryKey(entry) === directoryKey(target))
    if (targetIndex < 0) return
    next.splice(targetIndex + (after ? 1 : 0), 0, repo)
    saveRepoOrder(next)
  }

  const nudgeRepo = (repo: string, offset: -1 | 1): void => {
    const current = orderedRepos.map((entry) => entry.repo)
    const index = current.findIndex((entry) => directoryKey(entry) === directoryKey(repo))
    const target = index + offset
    if (index < 0 || target < 0 || target >= current.length) return
    const moved = current[index]
    current[index] = current[target]
    current[target] = moved
    saveRepoOrder(current)
  }

  const beginRepoDrag = (e: React.DragEvent<HTMLElement>, repo: string): void => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', repo)
    setRepoDrag({ repo, target: repo, after: false })
  }

  const dragOverRepo = (e: React.DragEvent<HTMLElement>, target: string): void => {
    if (!repoDrag) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const after = isNarrow
      ? e.clientY >= rect.top + rect.height / 2
      : e.clientX >= rect.left + rect.width / 2
    setRepoDrag((current) =>
      current && (current.target !== target || current.after !== after)
        ? { ...current, target, after }
        : current
    )
  }

  const dropRepo = (e: React.DragEvent<HTMLElement>, target: string): void => {
    if (!repoDrag) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const after = isNarrow
      ? e.clientY >= rect.top + rect.height / 2
      : e.clientX >= rect.left + rect.width / 2
    moveRepo(repoDrag.repo, target, after)
    setRepoDrag(null)
  }

  const nonaffiliatedSection = (): React.JSX.Element => {
    const needYou = sessionRows.filter((row) => needsOperator(row.signal)).length
    const hasRowStatus = sessionRows.some(
      ({ activity, signal }) =>
        (activity.status !== undefined && activity.status !== 'idle') || !!signal.label
    )
    return (
      <section className="wfm-repo wfm-nonaffiliated">
        <div className="wfm-repo-header">
          <span className="wfm-repo-name">Nonaffiliated</span>
          <span className="wfm-repo-path">Open sessions outside a workspace</span>
          {needYou > 0 && (
            <span
              className="wfm-repo-inbox"
              title={`${needYou} session${needYou === 1 ? '' : 's'} need your attention`}
            >
              {needYou} need{needYou === 1 ? 's' : ''} you
            </span>
          )}
        </div>
        {sessionRows.length === 0 ? (
          <div className="wfm-note wfm-note-muted">No open sessions outside a workspace.</div>
        ) : (
          <div className={`wfm-rows${hasRowStatus ? '' : ' wfm-rows-no-status'}`}>
            {sessionRows.map(({ session, activity, cost, signal }) => (
              <div className="wfm-row" key={session.id}>
                {hasRowStatus && (
                  <span className="wfm-row-status">
                    {activity.status && activity.status !== 'idle' && (
                      <span
                        className={`tab-status tab-status-${activity.status}`}
                        title={
                          activity.status === 'busy'
                            ? 'Busy'
                            : activity.summary.waiting > 0
                              ? 'Ready for input'
                              : 'Finished'
                        }
                      />
                    )}
                    {signal.label && (
                      <span
                        className={`wfm-inbox wfm-inbox-${signal.slug}`}
                        title={signalTitle(signal, activity)}
                      >
                        {signal.label}
                      </span>
                    )}
                  </span>
                )}
                <div className="wfm-row-main">
                  <span className="wfm-branch" title={session.dir}>
                    {session.label}
                  </span>
                  <span className="wfm-session-path" title={session.dir}>
                    {session.dir ?? 'Starting shell…'}
                  </span>
                  {activity.title && (
                    <span className="wfm-activity" title={activity.title}>
                      {activity.title}
                    </span>
                  )}
                  {!!cost && (
                    <span
                      className="wfm-cost"
                      title="Estimated agent spend in this directory since snow started"
                    >
                      {formatCost(cost)}
                    </span>
                  )}
                  <span className="wfm-row-actions">
                    <button
                      className="wfm-action wfm-action-launch"
                      onClick={() => onSelectSession(session.id)}
                      title={`Open ${session.label}`}
                    >
                      ▸ Open session
                    </button>
                    <button
                      className="wfm-action wfm-action-icon wfm-action-remove"
                      onClick={() => onCloseSession(session.id)}
                      title={`Close ${session.label}`}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    )
  }

  const repoCard = (repo: WorkflowRepo): React.JSX.Element => {
    const registered = isRegistered(repo.workflows)
    const rows: WorkflowRow[] = repo.workflows
      .map((entry, order) => {
        const dir = openDir(repo, entry)
        const indexed = dir ? indexedFor(dir) : { activity: emptyActivity, cost: 0 }
        const { activity, cost } = indexed
        return {
          entry,
          activity,
          cost,
          dir,
          order,
          signal: inboxSignal(
            entry,
            activity.summary,
            activity.status === 'attention' && activity.summary.waiting === 0
          )
        }
      })
      .sort(
        (left, right) =>
          right.signal.tier - left.signal.tier || right.cost - left.cost || left.order - right.order
      )
    const needYou = rows.filter((row) => needsOperator(row.signal)).length
    const hasRowStatus = rows.some(
      ({ entry, activity, signal }) =>
        (activity.status !== undefined && activity.status !== 'idle') ||
        !!signal.label ||
        !!stateLabel(entry)
    )
    return (
      <section
        className={`wfm-repo${repoDrag?.repo === repo.repo ? ' wfm-repo-dragging' : ''}${
          repoDrag?.target === repo.repo && repoDrag.repo !== repo.repo
            ? repoDrag.after
              ? ' wfm-repo-drop-after'
              : ' wfm-repo-drop-before'
            : ''
        }`}
        key={repo.repo}
        style={{ '--wfm-repo': repoColor(repo.repo, lanes) } as React.CSSProperties}
        onDragOver={(e) => dragOverRepo(e, repo.repo)}
        onDrop={(e) => dropRepo(e, repo.repo)}
        onDragEnd={() => setRepoDrag(null)}
      >
        <div className="wfm-repo-header">
          <button
            type="button"
            className="wfm-drag-handle"
            draggable
            onDragStart={(e) => beginRepoDrag(e, repo.repo)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                nudgeRepo(repo.repo, -1)
              } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                nudgeRepo(repo.repo, 1)
              }
            }}
            title="Drag to reorder; use arrow keys to move"
            aria-label={`Reorder ${repo.name}`}
          >
            ⠿
          </button>
          <span className="wfm-repo-name">{repo.name}</span>
          <span className="wfm-repo-path" title={repo.repo}>
            {repo.repo}
          </span>
          {needYou > 0 && (
            <span
              className="wfm-repo-inbox"
              title={`${needYou} workspace${needYou === 1 ? '' : 's'} need your attention`}
            >
              {needYou} need{needYou === 1 ? 's' : ''} you
            </span>
          )}
          <button
            className="wfm-launch-all"
            disabled={action.pending || repo.workflows.length === 0 || repo.unreachable}
            onClick={() => launchAll(repo)}
            title={`Open every workspace in ${repo.name}, applying each matching preset startup command`}
          >
            {repo.workflows.length > 1 ? ` Open all ${repo.workflows.length}` : ' Open'}
          </button>
        </div>
        {repo.unreachable && (
          <div className="wfm-note">
            snow could not read this repository - the directory may have moved or been deleted. Its
            workspace records can still be removed.
          </div>
        )}
        {repo.error && <div className="wfm-note">{repo.error}</div>}
        <div className={`wfm-rows${hasRowStatus ? '' : ' wfm-rows-no-status'}`}>
          {rows.map(({ entry, activity, cost, dir, signal }) => {
            const state = stateLabel(entry)
            const status = activity.status
            const title = activity.title
            return (
              <div className="wfm-row" key={entry.branch}>
                {hasRowStatus && (
                  <span className="wfm-row-status">
                    {status && status !== 'idle' && (
                      <span
                        className={`tab-status tab-status-${status}`}
                        title={
                          status === 'busy'
                            ? 'Busy'
                            : activity.summary.waiting > 0
                              ? 'Ready for input'
                              : 'Finished'
                        }
                      />
                    )}
                    {signal.label ? (
                      <span
                        className={`wfm-inbox wfm-inbox-${signal.slug}`}
                        title={signalTitle(signal, activity)}
                      >
                        {signal.label}
                      </span>
                    ) : (
                      state && (
                        <span className={`wfm-state wfm-state-${stateSlug(state)}`}>{state}</span>
                      )
                    )}
                  </span>
                )}
                <div className="wfm-row-main">
                  <button
                    type="button"
                    className={`wfm-branch wfm-branch-link${entry.exists ? '' : ' wfm-branch-missing'}`}
                    disabled={!dir || entry.review?.changed === 0}
                    onClick={() => dir && onOpenDiff(dir, entry.branch)}
                    title={
                      dir
                        ? entry.review
                          ? reviewTitle(entry, entry.review)
                          : `Open ${entry.branch}'s diff`
                        : (entry.worktree ?? parkedTitle(entry))
                    }
                  >
                    {entry.branch}
                  </button>
                  {title && (
                    <span className="wfm-activity" title={title}>
                      {title}
                    </span>
                  )}
                  {!!cost && (
                    <span
                      className="wfm-cost"
                      title="Estimated agent spend in this directory since snow started"
                    >
                      {formatCost(cost)}
                    </span>
                  )}
                  {entry.parked && (
                    <span className="wfm-parked" title={parkedTitle(entry)}>
                      {parkedBadge(entry.parked)}
                    </span>
                  )}
                  <span className="wfm-row-actions">
                    <button
                      className="wfm-action wfm-action-icon"
                      type="button"
                      disabled={action.pending}
                      aria-label={`Actions for ${entry.branch}`}
                      aria-haspopup="menu"
                      aria-expanded={
                        workflowMenu?.repo.repo === repo.repo &&
                        workflowMenu.entry.branch === entry.branch
                      }
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        setWorkflowMenu({ repo, entry, x: rect.right - 200, y: rect.bottom + 4 })
                      }}
                      title={`Actions for ${entry.branch}`}
                    >
                      ⋮
                    </button>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="wfm-repo-footer">
          <form className="wfm-create" onSubmit={(e) => create(repo, e)}>
            <input
              className="wfm-create-input"
              placeholder="New workspace…"
              value={drafts[repo.repo] ?? ''}
              disabled={repo.unreachable}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [repo.repo]: e.target.value }))}
            />
            <button
              className="wfm-action"
              type="submit"
              disabled={action.pending || !(drafts[repo.repo] ?? '').trim()}
            >
              +
            </button>
          </form>
          {repo.current && !registered && (
            <button
              className="wfm-action"
              disabled={action.pending}
              onClick={() => register(repo)}
              title={`Track ${repo.current} as a workspace branch`}
            >
              Register workspace
            </button>
          )}
        </div>
      </section>
    )
  }

  const body = (): React.JSX.Element => {
    if (!overview)
      return (
        <>
          {nonaffiliatedSection()}
          <div className="wfm-empty">Loading…</div>
        </>
      )
    if (overview.error)
      return (
        <>
          {nonaffiliatedSection()}
          <div className="wfm-empty">
            Could not read your workspaces.
            {'\n'}
            {overview.error}
          </div>
        </>
      )
    if (overview.repos.length === 0)
      return (
        <>
          {nonaffiliatedSection()}
          <div className="wfm-empty">
            No workspaces registered yet.
            {'\n'}
            Register a branch from the workspace dropdown in the action bar, and it shows up here.
          </div>
        </>
      )

    return (
      <>
        {nonaffiliatedSection()}
        <div className="wfm-repo-columns">
          {(isNarrow
            ? [orderedRepos]
            : [0, 1].map((column) => orderedRepos.filter((_, index) => index % 2 === column))
          ).map((repos, column) => (
            <div className="wfm-repo-column" key={column}>
              {repos.map(repoCard)}
            </div>
          ))}
        </div>
      </>
    )
  }

  return (
    <div className="wfm" style={{ display: active ? 'block' : 'none' }}>
      <div className="wfm-title">
        Workspaces
        {action.label && <span className="wfm-busy">{action.label}</span>}
      </div>
      <div className="wfm-grid">{body()}</div>
      {workflowMenu && (
        <ContextMenu x={workflowMenu.x} y={workflowMenu.y} onClose={() => setWorkflowMenu(null)}>
          <button
            className="context-menu-item context-menu-item--action"
            disabled={workflowMenu.repo.unreachable}
            onClick={() => {
              setWorkflowMenu(null)
              launch(workflowMenu.repo, workflowMenu.entry)
            }}
          >
            {usable(workflowMenu.entry) || workflowMenu.entry.current
              ? 'Open workspace shell'
              : 'Create isolated workspace'}
          </button>
          {workflowMenu.entry.worktree &&
            (usable(workflowMenu.entry) ? (
              <button
                className="context-menu-item context-menu-item--action"
                onClick={() => {
                  setWorkflowMenu(null)
                  setDemoting({ repo: workflowMenu.repo, entry: workflowMenu.entry })
                }}
              >
                Remove isolated workspace…
              </button>
            ) : (
              <button
                className="context-menu-item context-menu-item--action"
                disabled={workflowMenu.repo.unreachable}
                title={staleTitle(workflowMenu.entry)}
                onClick={() => {
                  setWorkflowMenu(null)
                  prune(workflowMenu.repo)
                }}
              >
                Prune stale workspace
              </button>
            ))}
          <button
            className="context-menu-item"
            onClick={() => {
              setWorkflowMenu(null)
              setRemoving({ repo: workflowMenu.repo, entry: workflowMenu.entry })
            }}
          >
            Remove from workflows…
          </button>
        </ContextMenu>
      )}
      {removing && (
        <RemoveWorkflowDialog
          entry={removing.entry}
          onCancel={() => setRemoving(null)}
          onConfirm={unregister}
        />
      )}
      {demoting && (
        <StopWorkflowDialog
          entry={demoting.entry}
          agents={(() => {
            const dir = openDir(demoting.repo, demoting.entry)
            return dir ? indexedFor(dir).activity.agents : []
          })()}
          onCancel={() => setDemoting(null)}
          onConfirm={demote}
        />
      )}
      {failure && <FailureDialog failure={failure} onDismiss={() => setFailure(null)} />}
    </div>
  )
}

export default memo(WorkflowManager)
