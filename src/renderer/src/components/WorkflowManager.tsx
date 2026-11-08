import { memo, useMemo, useState } from 'react'
import CleanupDialog from './CleanupDialog'
import ContextMenu from './ContextMenu'
import FailureDialog from './FailureDialog'
import RemoveWorkflowDialog from './RemoveWorkflowDialog'
import StopWorkflowDialog from './StopWorkflowDialog'
import WorkflowRepoCard from './WorkflowRepoCard'
import WorkflowSessionsSection from './WorkflowSessionsSection'
import type { SessionStatus } from '@renderer/agentStatus'
import { failureOf, type Failure } from '@renderer/format'
import { useGitAction } from '@renderer/useGitAction'
import { useGitColors } from '@renderer/useGitColors'
import { useMediaQuery } from '@renderer/useMediaQuery'
import { useRepoOrder } from '@renderer/useRepoOrder'
import { useWorkflowOverview } from '@renderer/useWorkflowOverview'
import type { AgentSession } from '@renderer/useAgents'
import {
  staleTitle,
  usable,
  type CleanupTarget,
  type WorkflowEntry,
  type WorkflowRepo,
  type WorkflowResult
} from '@renderer/workflowText'
import {
  activityFor,
  cleanupTargetsOf,
  directoryKey,
  failureList,
  indexActivity,
  nonaffiliatedSessions,
  openDir,
  orderRepos,
  repoRows,
  reviewTargetsOf,
  sessionRowsOf,
  workflowDirectories,
  type IndexedActivity,
  type OpenSession,
  type Targeted,
  type WorkflowReviewTarget,
  type WorkflowRow
} from '@renderer/workflowRows'

export type { WorkflowReviewTarget } from '@renderer/workflowRows'

type WorkflowMenu = Targeted & { x: number; y: number }

const narrowWorkspaceQuery = '(max-width: 1200px)'

const emptyIndex = new Map<string, IndexedActivity>()

interface WorkflowManagerProps {
  active: boolean
  onLaunch: (dir: string, repo: string) => void
  onSelectSession: (id: number) => void
  onCloseSession: (id: number) => void
  onOpenDiff: (cwd: string, branch: string) => void
  onReviewAll: (targets: WorkflowReviewTarget[]) => void
  onCloseWorktree?: (dir: string) => void
  sessionStatuses: Record<string, SessionStatus>
  sessionTitles: Record<string, string>
  agentSessions: AgentSession[]
  openSessions: OpenSession[]
  workspaceOrder: string[]
  onWorkspaceOrderChange: typeof window.api.snowconfig.setWorkspaceOrder
}

function outcome(failed: Failure | null): WorkflowResult {
  return failed ? { ok: false, error: failed.title, detail: failed.detail } : { ok: true }
}

function WorkflowManager({
  active,
  onLaunch,
  onSelectSession,
  onCloseSession,
  onOpenDiff,
  onReviewAll,
  onCloseWorktree,
  sessionStatuses,
  sessionTitles,
  agentSessions,
  openSessions,
  workspaceOrder,
  onWorkspaceOrderChange
}: WorkflowManagerProps): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [removing, setRemoving] = useState<Targeted | null>(null)
  const [demoting, setDemoting] = useState<Targeted | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [workflowMenu, setWorkflowMenu] = useState<WorkflowMenu | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const isNarrow = useMediaQuery(narrowWorkspaceQuery)
  const lanes = useGitColors()?.lanes
  const sessionDirectoryKey = useMemo(
    () =>
      [...new Set(openSessions.map((session) => session.dir).filter((dir): dir is string => !!dir))]
        .sort((a, b) => directoryKey(a).localeCompare(directoryKey(b)))
        .join('\0'),
    [openSessions]
  )
  const overview = useWorkflowOverview(active, refreshKey, sessionDirectoryKey)

  const toggleOverlaps = (key: string): void =>
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const action = useGitAction<WorkflowResult>({
    onFailure: setFailure,
    onSettled: () => setRefreshKey((key) => key + 1)
  })

  const nonaffiliated = useMemo(
    () => nonaffiliatedSessions(openSessions, workflowDirectories(overview?.repos ?? [])),
    [openSessions, overview]
  )
  const comparisonsByDirectory = useMemo(
    () =>
      new Map(
        (overview?.comparisons ?? []).map((comparison) => [
          directoryKey(comparison.directory),
          comparison
        ])
      ),
    [overview]
  )

  const indexedRows = useMemo(
    () =>
      active
        ? indexActivity({
            repos: overview?.repos ?? [],
            nonaffiliated,
            openSessions,
            agentSessions,
            sessionStatuses,
            sessionTitles
          })
        : emptyIndex,
    [active, overview, agentSessions, sessionStatuses, sessionTitles, nonaffiliated, openSessions]
  )

  const sessionRows = useMemo(
    () => sessionRowsOf(agentSessions, nonaffiliated, comparisonsByDirectory),
    [agentSessions, nonaffiliated, comparisonsByDirectory]
  )

  const orderedRepos = useMemo(
    () => orderRepos(overview?.repos ?? [], workspaceOrder),
    [overview, workspaceOrder]
  )

  const rowsByRepo = useMemo(
    () => new Map(orderedRepos.map((repo) => [repo.repo, repoRows(repo, indexedRows)])),
    [orderedRepos, indexedRows]
  )
  const rowsFor = (repo: WorkflowRepo): WorkflowRow[] => rowsByRepo.get(repo.repo) ?? []

  const reviewTargets = reviewTargetsOf(orderedRepos, rowsFor)
  const cleanupTargets = cleanupTargetsOf(orderedRepos, rowsFor)

  const order = useRepoOrder(orderedRepos, isNarrow, (next) => {
    void onWorkspaceOrderChange(next).then((result) => {
      if (!result.error) return
      setFailure({
        title: 'Could not save workspace order',
        detail: `${result.path}\n${result.error}`
      })
    })
  })

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
    action.run(async () => outcome(await launchOne(repo, entry)), 'Opening workspace…')
  }

  const launchAll = (repo: WorkflowRepo): void => {
    if (action.pending || repo.workflows.length === 0) return
    action.run(async () => {
      const failed: string[] = []
      for (const entry of repo.workflows) {
        const problem = await launchOne(repo, entry)
        if (problem) failed.push(failureList(entry.branch, problem.title, problem.detail))
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

  const demoteOne = async (repo: string, branch: string): Promise<Failure | null> => {
    const result = await window.api.workflow.demote(repo, branch)
    if (result.worktree) onCloseWorktree?.(result.worktree)
    return result.ok ? null : failureOf(result)
  }

  const demote = (): void => {
    const target = demoting
    setDemoting(null)
    if (!target || action.pending) return
    action.run(
      async () => outcome(await demoteOne(target.repo.repo, target.entry.branch)),
      'Removing workspace…'
    )
  }

  const cleanupOne = async (target: CleanupTarget): Promise<Failure | null> => {
    if (target.kind === 'orphan') {
      const result = await window.api.workflow.removeWorktree(target.repo, target.directory)
      if (result.worktree) onCloseWorktree?.(result.worktree)
      return result.ok ? null : failureOf(result)
    }
    if (target.kind === 'workspace' && target.directory) {
      const stopped = await demoteOne(target.repo, target.branch)
      if (stopped) return stopped
    }
    const dropped = await window.api.workflow.unregister(target.repo, target.branch)
    return dropped.ok ? null : failureOf(dropped)
  }

  const cleanup = (selected: CleanupTarget[]): void => {
    setCleaning(false)
    if (selected.length === 0 || action.pending) return
    const staleRepos = new Set(
      selected.filter((target) => target.kind === 'stale').map((target) => target.repo)
    )
    action.run(async () => {
      const failed: string[] = []
      for (const target of selected) {
        const problem = await cleanupOne(target)
        if (problem) failed.push(failureList(target.branch, problem.title, problem.detail))
      }
      for (const repo of staleRepos) await window.api.workflow.prune(repo)
      if (failed.length === 0) return { ok: true }
      return {
        ok: false,
        error: `Cleaned up ${selected.length - failed.length} of ${selected.length} workspaces`,
        detail: failed.join('\n\n')
      }
    }, 'Cleaning up…')
  }

  const sessionsSection = (
    <WorkflowSessionsSection
      rows={sessionRows}
      expanded={expanded}
      onToggleOverlaps={toggleOverlaps}
      onOpenDiff={onOpenDiff}
      onSelectSession={onSelectSession}
      onCloseSession={onCloseSession}
    />
  )

  const repoCard = (repo: WorkflowRepo): React.JSX.Element => (
    <WorkflowRepoCard
      key={repo.repo}
      repo={repo}
      rows={rowsFor(repo)}
      lanes={lanes}
      pending={action.pending}
      order={order}
      expanded={expanded}
      menuBranch={workflowMenu?.repo.repo === repo.repo ? workflowMenu.entry.branch : null}
      draft={drafts[repo.repo] ?? ''}
      onToggleOverlaps={toggleOverlaps}
      onOpenMenu={(entry, x, y) => setWorkflowMenu({ repo, entry, x, y })}
      onLaunch={(entry) => launch(repo, entry)}
      onLaunchAll={() => launchAll(repo)}
      onOpenDiff={onOpenDiff}
      onSelectSession={onSelectSession}
      onDraftChange={(value) => setDrafts((prev) => ({ ...prev, [repo.repo]: value }))}
      onCreate={(e) => create(repo, e)}
      onRegister={() => register(repo)}
    />
  )

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
    )
  }

  const demotingAgents = (target: Targeted): AgentSession[] => {
    const dir = openDir(target.repo, target.entry)
    return dir ? activityFor(indexedRows, dir).activity.agents : []
  }

  return (
    <div className="wfm" style={{ display: active ? 'block' : 'none' }}>
      <div className="wfm-title">
        <span>Workspaces</span>
        {action.label && <span className="wfm-busy">{action.label}</span>}
        <button
          type="button"
          className="wfm-review-all"
          disabled={reviewTargets.length === 0}
          onClick={() => onReviewAll(reviewTargets)}
          title={
            reviewTargets.length === 0
              ? 'No workflows are ready to review'
              : `Review ${reviewTargets.length} workflow${reviewTargets.length === 1 ? '' : 's'} in one tab`
          }
        >
          Review all{reviewTargets.length > 0 ? ` (${reviewTargets.length})` : ''}
        </button>
        <button
          type="button"
          className="wfm-clean-up"
          disabled={cleanupTargets.length === 0 || action.pending}
          onClick={() => setCleaning(true)}
          title={
            cleanupTargets.length === 0
              ? 'Nothing has landed on a default branch yet'
              : `Retire ${cleanupTargets.length} workspace${cleanupTargets.length === 1 ? '' : 's'} whose work is already merged`
          }
        >
          Clean up{cleanupTargets.length > 0 ? ` (${cleanupTargets.length})` : ''}
        </button>
      </div>
      <div className="wfm-grid">
        {sessionsSection}
        {body()}
      </div>
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
      {cleaning && cleanupTargets.length > 0 && (
        <CleanupDialog
          targets={cleanupTargets}
          onCancel={() => setCleaning(false)}
          onConfirm={cleanup}
        />
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
          agents={demotingAgents(demoting)}
          onCancel={() => setDemoting(null)}
          onConfirm={demote}
        />
      )}
      {failure && <FailureDialog failure={failure} onDismiss={() => setFailure(null)} />}
    </div>
  )
}

export default memo(WorkflowManager)
