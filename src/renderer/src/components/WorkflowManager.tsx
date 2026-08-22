import { memo, useEffect, useRef, useState } from 'react'
import FailureDialog from './FailureDialog'
import RemoveWorkflowDialog from './RemoveWorkflowDialog'
import StopWorkflowDialog from './StopWorkflowDialog'
import type { SessionStatus } from '../App'
import { failureOf, isInside, normalizePath, type Failure } from '@renderer/format'
import { repoColor } from '@renderer/repoColor'
import { useGitAction } from '@renderer/useGitAction'
import { useGitColors } from '@renderer/useGitColors'
import { useLatestRun } from '@renderer/useLatestRun'
import {
  isRegistered,
  launchLabel,
  parkedTitle,
  staleTitle,
  stateLabel,
  usable,
  type WorkflowEntry,
  type WorkflowRepo,
  type WorkflowResult
} from '@renderer/workflowText'

type Overview = Awaited<ReturnType<typeof window.api.workflow.overview>>
type Targeted = { repo: WorkflowRepo; entry: WorkflowEntry }

interface WorkflowManagerProps {
  active: boolean
  onLaunch: (dir: string, repo: string) => void
  onCloseWorktree?: (dir: string) => void
  sessionStatuses: Record<string, SessionStatus>
  sessionTitles: Record<string, string>
}

function openDir(repo: WorkflowRepo, entry: WorkflowEntry): string | undefined {
  if (usable(entry) && entry.worktree) return entry.worktree
  if (entry.current) return repo.repo
  return undefined
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
  onCloseWorktree,
  sessionStatuses,
  sessionTitles
}: WorkflowManagerProps): React.JSX.Element {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [removing, setRemoving] = useState<Targeted | null>(null)
  const [demoting, setDemoting] = useState<Targeted | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const latestRun = useLatestRun()
  const lanes = useGitColors()?.lanes
  const overviewRef = useRef<Overview | null>(null)
  useEffect(() => {
    overviewRef.current = overview
  }, [overview])

  const action = useGitAction<WorkflowResult>({
    onFailure: setFailure,
    onSettled: () => setRefreshKey((key) => key + 1)
  })

  useEffect(() => {
    const load = async (): Promise<void> => {
      const isCurrent = latestRun()
      const result = await window.api.workflow.overview()
      if (!isCurrent()) return
      setOverview(result)
    }

    load()
    const offGit = window.api.git.onChanged((changedCwd) => {
      const inScope = overviewRef.current?.repos.some(
        (repo) => changedCwd && isInside(normalizePath(changedCwd), normalizePath(repo.repo))
      )
      if (inScope) load()
    })
    const offWorkflow = window.api.workflow.onChanged(() => load())

    return () => {
      offGit()
      offWorkflow()
    }
  }, [refreshKey, latestRun])

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
    }, 'Launching…')
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
    }, `Launching ${repo.name}…`)
  }

  const create = (repo: WorkflowRepo, e: React.FormEvent): void => {
    e.preventDefault()
    const name = (drafts[repo.repo] ?? '').trim()
    if (!name || action.pending) return
    setDrafts((prev) => ({ ...prev, [repo.repo]: '' }))
    action.run(() => window.api.workflow.create(repo.repo, name), 'Creating…')
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
    }, 'Stopping parallel session…')
  }

  const body = (): React.JSX.Element => {
    if (!overview) return <div className="wfm-empty">Loading…</div>
    if (overview.error)
      return (
        <div className="wfm-empty">
          Could not read your workflows.
          {'\n'}
          {overview.error}
        </div>
      )
    if (overview.repos.length === 0)
      return (
        <div className="wfm-empty">
          No workflows registered yet.
          {'\n'}
          Register a branch from the workflow dropdown in the action bar, and it shows up here.
        </div>
      )

    return (
      <>
        {overview.repos.map((repo) => {
          const registered = isRegistered(repo.workflows)
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
                <button
                  className="wfm-launch-all"
                  disabled={action.pending || repo.workflows.length === 0 || repo.unreachable}
                  onClick={() => launchAll(repo)}
                  title={`Open a session for every workflow in ${repo.name}, promoting the parked ones to worktrees`}
                >
                  ▸ Launch all {repo.workflows.length}
                </button>
              </div>
              {repo.unreachable && (
                <div className="wfm-note">
                  snow could not read this repository - the directory may have moved or been
                  deleted. Its workflows can still be removed.
                </div>
              )}
              {repo.error && <div className="wfm-note">{repo.error}</div>}
              <div className="wfm-rows">
                {repo.workflows.map((entry) => {
                  const state = stateLabel(entry)
                  const dir = openDir(repo, entry)
                  const status = dir ? sessionStatuses[normalizePath(dir)] : undefined
                  const title = dir ? sessionTitles[normalizePath(dir)] : undefined
                  return (
                    <div className="wfm-row" key={entry.branch}>
                      <span className="wfm-row-status">
                        {status && status !== 'idle' && (
                          <span
                            className={`tab-status tab-status-${status}`}
                            title={status === 'busy' ? 'Busy' : 'Ready for input'}
                          />
                        )}
                        {state && (
                          <span className={`wfm-state wfm-state-${state}`}>{state}</span>
                        )}
                      </span>
                      <span
                        className={`wfm-branch${entry.exists ? '' : ' wfm-branch-missing'}`}
                        title={entry.worktree ?? parkedTitle(entry)}
                      >
                        {entry.branch}
                      </span>
                      {title && (
                        <span className="wfm-activity" title={title}>
                          {title}
                        </span>
                      )}
                      {entry.parked && (
                        <span className="wfm-parked" title={parkedTitle(entry)}>
                          ● {entry.parked.files ?? '?'}
                        </span>
                      )}
                      <span className="wfm-row-actions">
                        <button
                          className="wfm-action wfm-action-launch"
                          disabled={action.pending || repo.unreachable}
                          onClick={() => launch(repo, entry)}
                          title={
                            usable(entry) || entry.current
                              ? `Open ${entry.branch}'s session`
                              : `Run ${entry.branch} in its own worktree`
                          }
                        >
                          ▸ {launchLabel(entry)}
                        </button>
                        <span className="wfm-action-slot">
                          {usable(entry) && (
                            <button
                              className="wfm-action wfm-action-icon"
                              disabled={action.pending}
                              onClick={() => setDemoting({ repo, entry })}
                              title={`Stop ${entry.branch}'s parallel session`}
                            >
                              󰏤
                            </button>
                          )}
                          {entry.worktree && !usable(entry) && (
                            <button
                              className="wfm-action wfm-action-icon"
                              disabled={action.pending || repo.unreachable}
                              onClick={() => prune(repo)}
                              title={staleTitle(entry)}
                            >
                              ⟳
                            </button>
                          )}
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
                    placeholder="New workflow…"
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
                    title={`Track ${repo.current} as a workflow`}
                  >
                    Register {repo.current}
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
        Workflows
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
          onCancel={() => setDemoting(null)}
          onConfirm={demote}
        />
      )}
      {failure && <FailureDialog failure={failure} onDismiss={() => setFailure(null)} />}
    </div>
  )
}

export default memo(WorkflowManager)
