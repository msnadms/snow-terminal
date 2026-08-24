import { memo, useEffect, useMemo, useRef, useState } from 'react'
import FailureDialog from './FailureDialog'
import RemoveWorkflowDialog from './RemoveWorkflowDialog'
import StopWorkflowDialog from './StopWorkflowDialog'
import type { SessionStatus } from '../App'
import { failureOf, formatCost, isInside, normalizePath, type Failure } from '@renderer/format'
import { repoColor } from '@renderer/repoColor'
import { useGitAction } from '@renderer/useGitAction'
import { useGitColors } from '@renderer/useGitColors'
import { useLatestRun } from '@renderer/useLatestRun'
import { useUsage } from '@renderer/useUsage'
import {
  agentSummary,
  liveAgentsIn,
  type AgentSession,
  type AgentSummary
} from '@renderer/useAgents'
import {
  inboxSignal,
  inScope,
  isRegistered,
  launchLabel,
  parkedBadge,
  parkedTitle,
  repoScope,
  reviewBadge,
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

interface WorkflowManagerProps {
  active: boolean
  onLaunch: (dir: string, repo: string) => void
  onOpenDiff: (cwd: string, branch: string) => void
  onCloseWorktree?: (dir: string) => void
  sessionStatuses: Record<string, SessionStatus>
  sessionTitles: Record<string, string>
  agentSessions: AgentSession[]
}

function openDir(repo: WorkflowRepo, entry: WorkflowEntry): string | undefined {
  if (usable(entry) && entry.worktree) return entry.worktree
  if (entry.current) return repo.repo
  return undefined
}

function signalTitle(signal: InboxSignal, activity: Activity): string {
  const names = activity.summary.names
  const who = names.length > 1 ? `${signal.label} (${names.join(', ')})` : signal.label
  return activity.title ? `${who}\n${activity.title}` : who
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
  onOpenDiff,
  onCloseWorktree,
  sessionStatuses,
  sessionTitles,
  agentSessions
}: WorkflowManagerProps): React.JSX.Element {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [removing, setRemoving] = useState<Targeted | null>(null)
  const [demoting, setDemoting] = useState<Targeted | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const latestRun = useLatestRun()
  const lanes = useGitColors()?.lanes
  const usage = useUsage()
  const directoryKey = (dir: string): string => {
    const normalized = normalizePath(dir)
    return navigator.platform.startsWith('Win') ? normalized.toLowerCase() : normalized
  }

  /** Cost is recorded against each agent session's own cwd, so a row sums its whole subtree. */
  const costDirs = useMemo(
    () =>
      Object.entries(usage?.byDirectory ?? {}).map(
        ([dir, cost]) => [directoryKey(dir), cost] as const
      ),
    [usage]
  )
  const costFor = (dir: string): number => {
    const root = directoryKey(dir)
    return costDirs.reduce((sum, [key, cost]) => (isInside(key, root) ? sum + cost : sum), 0)
  }
  const activityFor = (dir: string): Activity => {
    const root = normalizePath(dir)
    const rank: Record<SessionStatus, number> = { attention: 2, busy: 1, idle: 0 }
    const agents = liveAgentsIn(agentSessions, dir)
    let tabSelected: { path: string; status: SessionStatus } | null = null
    for (const [path, status] of Object.entries(sessionStatuses)) {
      if (!isInside(path, root)) continue
      if (!tabSelected || rank[status] > rank[tabSelected.status]) tabSelected = { path, status }
    }
    const tabTitle = tabSelected ? sessionTitles[tabSelected.path] : undefined
    const summary = agentSummary(agents)
    if (!agents.length) {
      if (!tabSelected) return { agents, summary }
      const status = tabSelected.status
      return { status, title: status === 'idle' ? undefined : tabTitle, agents, summary }
    }

    const detail = agents
      .map((session) => session.detail)
      .filter(Boolean)
      .join('\n')
    return {
      status: summary.waiting ? 'attention' : 'busy',
      title: tabTitle || detail,
      agents,
      summary
    }
  }
  const overviewRef = useRef<Overview | null>(null)
  const watchedDirsRef = useRef(new Map<string, string>())
  useEffect(() => {
    overviewRef.current = overview
  }, [overview])

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

    const load = async (): Promise<void> => {
      const isCurrent = latestRun()
      const result = await window.api.workflow.overview(true)
      if (!isCurrent()) return
      setOverview(result)
    }

    load()
    // A repo's linked worktrees live outside its root but share its stash, so they count as in
    // scope too - without them a commit in a parallel session never refreshes this screen.
    const offGit = window.api.git.onChanged((changedCwd) => {
      const hit = overviewRef.current?.repos.some((repo) =>
        inScope(changedCwd, repoScope(repo.repo, repo.workflows))
      )
      if (hit) load()
    })
    const offWorkflow = window.api.workflow.onChanged(() => load())

    return () => {
      offGit()
      offWorkflow()
    }
  }, [active, refreshKey, latestRun])

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

  const body = (): React.JSX.Element => {
    if (!overview) return <div className="wfm-empty">Loading…</div>
    if (overview.error)
      return (
        <div className="wfm-empty">
          Could not read your workspaces.
          {'\n'}
          {overview.error}
        </div>
      )
    if (overview.repos.length === 0)
      return (
        <div className="wfm-empty">
          No workspaces registered yet.
          {'\n'}
          Register a branch from the workspace dropdown in the action bar, and it shows up here.
        </div>
      )

    return (
      <>
        {overview.repos.map((repo) => {
          const registered = isRegistered(repo.workflows)
          const rows: WorkflowRow[] = repo.workflows
            .map((entry, order) => {
              const dir = openDir(repo, entry)
              const activity: Activity = dir
                ? activityFor(dir)
                : { agents: [], summary: { waiting: 0, working: 0, names: [] } }
              const cost = dir ? costFor(dir) : 0
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
                right.signal.tier - left.signal.tier ||
                right.cost - left.cost ||
                left.order - right.order
            )
          const needYou = rows.filter((row) => needsOperator(row.signal)).length
          return (
            <section
              className="wfm-repo"
              key={repo.repo}
              style={{ '--wfm-repo': repoColor(repo.repo, lanes) } as React.CSSProperties}
            >
              <div className="wfm-repo-header">
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
                  ▸ Open all {repo.workflows.length}
                </button>
              </div>
              {repo.unreachable && (
                <div className="wfm-note">
                  snow could not read this repository - the directory may have moved or been
                  deleted. Its workspace records can still be removed.
                </div>
              )}
              {repo.error && <div className="wfm-note">{repo.error}</div>}
              <div className="wfm-rows">
                {rows.map(({ entry, activity, cost, dir, signal }) => {
                  const state = stateLabel(entry)
                  const status = activity.status
                  const title = activity.title
                  return (
                    <div className="wfm-row" key={entry.branch}>
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
                            <span className={`wfm-state wfm-state-${stateSlug(state)}`}>
                              {state}
                            </span>
                          )
                        )}
                      </span>
                      <span
                        className={`wfm-branch${entry.exists ? '' : ' wfm-branch-missing'}`}
                        title={entry.worktree ?? parkedTitle(entry)}
                      >
                        {entry.branch}
                      </span>
                      {entry.review && (
                        <button
                          className="wfm-review"
                          disabled={entry.review.changed === 0 || !dir}
                          onClick={() => dir && onOpenDiff(dir, entry.branch)}
                          title={reviewTitle(entry, entry.review)}
                        >
                          {reviewBadge(entry.review)}
                        </button>
                      )}
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
                          className="wfm-action wfm-action-launch"
                          disabled={action.pending || repo.unreachable}
                          onClick={() => launch(repo, entry)}
                          title={
                            usable(entry) || entry.current
                              ? `Open ${entry.branch}'s workspace shell`
                              : `Create ${entry.branch}'s isolated workspace`
                          }
                        >
                          ▸ {launchLabel(entry)}
                        </button>
                        <span className="wfm-action-slot">
                          {usable(entry) ? (
                            <button
                              className="wfm-action wfm-action-icon"
                              disabled={action.pending}
                              onClick={() => setDemoting({ repo, entry })}
                              title={`Remove ${entry.branch}'s workspace and terminate its terminals if required`}
                            >
                              󰏤
                            </button>
                          ) : entry.worktree ? (
                            <button
                              className="wfm-action wfm-action-icon"
                              disabled={action.pending || repo.unreachable}
                              onClick={() => prune(repo)}
                              title={staleTitle(entry)}
                            >
                              ⟳
                            </button>
                          ) : null}
                        </span>
                        <button
                          className="wfm-action wfm-action-icon wfm-action-remove"
                          disabled={action.pending}
                          onClick={() => setRemoving({ repo, entry })}
                          title={`Remove ${entry.branch} from your workflows`}
                        >
                          ✕
                        </button>
                      </span>
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
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [repo.repo]: e.target.value }))
                    }
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
                <span className="wfm-base">
                  {repo.defaultBranch
                    ? `Branches from origin/${repo.defaultBranch}`
                    : 'Branches from HEAD'}
                </span>
              </div>
            </section>
          )
        })}
      </>
    )
  }

  return (
    <div className="wfm" style={{ display: active ? 'block' : 'none' }}>
      <div className="wfm-title">
        Workspaces
        {action.label && <span className="wfm-busy">{action.label}</span>}
      </div>
      {body()}
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
            return dir ? activityFor(dir).agents : []
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
