import { Fragment } from 'react'
import { OverlapBadge, OverlapPanel } from './OverlapBadge'
import { repoColor } from '@renderer/repoColor'
import type { RepoOrder } from '@renderer/useRepoOrder'
import {
  isRegistered,
  needsOperator,
  parkedBadge,
  parkedTitle,
  reviewTitle,
  stateLabel,
  stateSlug,
  type WorkflowEntry,
  type WorkflowRepo
} from '@renderer/workflowText'
import { signalTitle, statusTitle, type WorkflowRow } from '@renderer/workflowRows'

interface WorkflowRepoCardProps {
  repo: WorkflowRepo
  rows: WorkflowRow[]
  lanes: string[] | undefined
  pending: boolean
  order: RepoOrder
  expanded: Set<string>
  menuBranch: string | null
  draft: string
  onToggleOverlaps: (key: string) => void
  onOpenMenu: (entry: WorkflowEntry, x: number, y: number) => void
  onLaunch: (entry: WorkflowEntry) => void
  onLaunchAll: () => void
  onOpenDiff: (cwd: string, branch: string) => void
  onSelectSession: (id: number) => void
  onDraftChange: (value: string) => void
  onCreate: (e: React.FormEvent) => void
  onRegister: () => void
}

function dragClass(repo: string, order: RepoOrder): string {
  const { drag } = order
  if (!drag) return ''
  if (drag.repo === repo) return ' wfm-repo-dragging'
  if (drag.target !== repo) return ''
  return drag.after ? ' wfm-repo-drop-after' : ' wfm-repo-drop-before'
}

function WorkflowRepoCard({
  repo,
  rows,
  lanes,
  pending,
  order,
  expanded,
  menuBranch,
  draft,
  onToggleOverlaps,
  onOpenMenu,
  onLaunch,
  onLaunchAll,
  onOpenDiff,
  onSelectSession,
  onDraftChange,
  onCreate,
  onRegister
}: WorkflowRepoCardProps): React.JSX.Element {
  const registered = isRegistered(repo.workflows)
  const needYou = rows.filter((row) => needsOperator(row.signal)).length
  const hasRowStatus = rows.some(
    ({ entry, activity, signal }) =>
      (activity.status !== undefined && activity.status !== 'idle') ||
      !!signal.label ||
      !!stateLabel(entry)
  )
  return (
    <section
      className={`wfm-repo${dragClass(repo.repo, order)}`}
      style={{ '--wfm-repo': repoColor(repo.repo, lanes) } as React.CSSProperties}
      onDragOver={(e) => order.over(e, repo.repo)}
      onDrop={(e) => order.drop(e, repo.repo)}
      onDragEnd={order.end}
    >
      <div className="wfm-repo-header">
        <button
          type="button"
          className="wfm-drag-handle"
          draggable
          onDragStart={(e) => order.begin(e, repo.repo)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault()
              order.nudge(repo.repo, -1)
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault()
              order.nudge(repo.repo, 1)
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
          disabled={pending || repo.workflows.length === 0 || repo.unreachable}
          onClick={onLaunchAll}
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
        {rows.map(({ entry, activity, dir, signal }) => {
          const state = stateLabel(entry)
          const { status, title } = activity
          const overlapKey = `${repo.repo}\0${entry.branch}`
          const panelId = `wfm-overlaps-${overlapKey.replace(/[^A-Za-z0-9]+/g, '-')}`
          const isOpen = expanded.has(overlapKey)
          return (
            <Fragment key={entry.branch}>
              <div className="wfm-row">
                {hasRowStatus && (
                  <span className="wfm-row-status">
                    {status && status !== 'idle' && (
                      <span
                        className={`tab-status tab-status-${status}`}
                        title={statusTitle(status, activity)}
                      />
                    )}
                    {signal.label ? (
                      <button
                        type="button"
                        className={`wfm-inbox wfm-inbox-${signal.slug}`}
                        disabled={!dir || entry.review?.changed === 0}
                        onClick={() => dir && onOpenDiff(dir, entry.branch)}
                        title={`${signalTitle(signal, activity)}\nOpen ${entry.branch}'s diff`}
                        aria-label={`Open ${entry.branch}'s diff: ${signal.label}`}
                      >
                        {signal.label}
                      </button>
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
                    disabled={activity.sessionId == null && (pending || repo.unreachable)}
                    onClick={() =>
                      activity.sessionId == null
                        ? onLaunch(entry)
                        : onSelectSession(activity.sessionId)
                    }
                    title={
                      dir
                        ? entry.review
                          ? `${reviewTitle(entry, entry.review)}\nOpen ${entry.branch}'s session`
                          : `Open ${entry.branch}'s session`
                        : (entry.worktree ?? parkedTitle(entry))
                    }
                  >
                    {entry.branch}
                  </button>
                  <OverlapBadge
                    report={entry}
                    label={entry.branch}
                    panelId={panelId}
                    expanded={isOpen}
                    onToggle={() => onToggleOverlaps(overlapKey)}
                  />
                  {title && (
                    <span className="wfm-activity" title={title}>
                      {title}
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
                      disabled={pending}
                      aria-label={`Actions for ${entry.branch}`}
                      aria-haspopup="menu"
                      aria-expanded={menuBranch === entry.branch}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        onOpenMenu(entry, rect.right - 200, rect.bottom + 4)
                      }}
                      title={`Actions for ${entry.branch}`}
                    >
                      ⋮
                    </button>
                  </span>
                </div>
              </div>
              {isOpen && <OverlapPanel report={entry} panelId={panelId} />}
            </Fragment>
          )
        })}
      </div>
      <div className="wfm-repo-footer">
        <form className="wfm-create" onSubmit={onCreate}>
          <input
            className="wfm-create-input"
            placeholder="New workspace…"
            value={draft}
            disabled={repo.unreachable}
            onChange={(e) => onDraftChange(e.target.value)}
          />
          <button className="wfm-action" type="submit" disabled={pending || !draft.trim()}>
            +
          </button>
        </form>
        {repo.current && !registered && (
          <button
            className="wfm-action"
            disabled={pending}
            onClick={onRegister}
            title={`Track ${repo.current} as a workspace branch`}
          >
            Register workspace
          </button>
        )}
      </div>
    </section>
  )
}

export default WorkflowRepoCard
