import { Fragment } from 'react'
import { OverlapBadge, OverlapPanel } from './OverlapBadge'
import { needsOperator } from '@renderer/workflowText'
import { signalTitle, statusTitle, type SessionRow } from '@renderer/workflowRows'

interface WorkflowSessionsSectionProps {
  rows: SessionRow[]
  expanded: Set<string>
  onToggleOverlaps: (key: string) => void
  onOpenDiff: (cwd: string, branch: string) => void
  onSelectSession: (id: number) => void
  onCloseSession: (id: number) => void
}

function WorkflowSessionsSection({
  rows,
  expanded,
  onToggleOverlaps,
  onOpenDiff,
  onSelectSession,
  onCloseSession
}: WorkflowSessionsSectionProps): React.JSX.Element {
  const needYou = rows.filter((row) => needsOperator(row.signal)).length
  const hasRowStatus = rows.some(
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
      {rows.length === 0 ? (
        <div className="wfm-note wfm-note-muted">No open sessions outside a workspace.</div>
      ) : (
        <div className={`wfm-rows${hasRowStatus ? '' : ' wfm-rows-no-status'}`}>
          {rows.map(({ session, activity, signal, comparison }) => {
            const overlapKey = `session\0${session.id}`
            const panelId = `wfm-overlaps-session-${session.id}`
            const isOpen = expanded.has(overlapKey)
            return (
              <Fragment key={session.id}>
                <div className="wfm-row">
                  {hasRowStatus && (
                    <span className="wfm-row-status">
                      {activity.status && activity.status !== 'idle' && (
                        <span
                          className={`tab-status tab-status-${activity.status}`}
                          title={statusTitle(activity.status, activity)}
                        />
                      )}
                      {signal.label && (
                        <button
                          type="button"
                          className={`wfm-inbox wfm-inbox-${signal.slug}`}
                          disabled={!session.dir}
                          onClick={() => session.dir && onOpenDiff(session.dir, session.label)}
                          title={`${signalTitle(signal, activity)}\nOpen ${session.label}'s diff`}
                          aria-label={`Open ${session.label}'s diff: ${signal.label}`}
                        >
                          {signal.label}
                        </button>
                      )}
                    </span>
                  )}
                  <div className="wfm-row-main">
                    <button
                      type="button"
                      className="wfm-branch wfm-branch-link"
                      onClick={() => onSelectSession(session.id)}
                      title={
                        session.dir
                          ? `${session.dir}\nOpen ${session.label}`
                          : `Open ${session.label}`
                      }
                    >
                      {session.label}
                    </button>
                    {comparison && (
                      <OverlapBadge
                        report={comparison}
                        label={session.label}
                        panelId={panelId}
                        expanded={isOpen}
                        onToggle={() => onToggleOverlaps(overlapKey)}
                      />
                    )}
                    <span className="wfm-session-path" title={session.dir}>
                      {session.dir ?? 'Starting shell…'}
                    </span>
                    {activity.title && (
                      <span className="wfm-activity" title={activity.title}>
                        {activity.title}
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
                {comparison && isOpen && <OverlapPanel report={comparison} panelId={panelId} />}
              </Fragment>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default WorkflowSessionsSection
