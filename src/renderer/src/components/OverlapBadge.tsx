import {
  overlapClaimants,
  overlapCounts,
  overlapHidden,
  overlapSummary,
  overlapTitle,
  overlapVerdict,
  type WorkflowOverlapReport
} from '@renderer/workflowText'

interface OverlapBadgeProps {
  report: WorkflowOverlapReport
  label: string
  panelId: string
  expanded: boolean
  onToggle: () => void
}

export function OverlapBadge({
  report,
  label,
  panelId,
  expanded,
  onToggle
}: OverlapBadgeProps): React.JSX.Element | null {
  const counts = overlapCounts(report)
  if (counts.total === 0) return null
  return (
    <button
      className="wfm-conflicts"
      type="button"
      aria-expanded={expanded}
      aria-controls={panelId}
      aria-label={`${label}: ${overlapSummary(report)}`}
      title={overlapTitle(report)}
      onClick={onToggle}
    >
      {counts.conflict > 0 && (
        <span className="wfm-unit wfm-unit-conflict">
          <span className="wfm-nerd">{''}</span>
          {counts.conflict}
        </span>
      )}
      {counts.unproven > 0 && (
        <span className="wfm-unit wfm-unit-unproven">
          <span className="wfm-nerd">{''}</span>
          {counts.unproven}
        </span>
      )}
      {counts.clean > 0 && (
        <span className="wfm-unit wfm-unit-clean">
          <span className="wfm-nerd">{''}</span>
          {counts.clean}
        </span>
      )}
    </button>
  )
}

export function OverlapPanel({
  report,
  panelId
}: {
  report: WorkflowOverlapReport
  panelId: string
}): React.JSX.Element | null {
  const hidden = overlapHidden(report)
  if (overlapCounts(report).total === 0) return null
  return (
    <div className="wfm-overlaps" id={panelId}>
      {(report.overlaps ?? []).map((overlap) => (
        <div className={`wfm-overlap wfm-overlap-${overlap.verdict}`} key={overlap.path}>
          <span className="wfm-overlap-path">{overlap.path}</span>
          <span className="wfm-overlap-verdict">{overlapVerdict(overlap)}</span>
          <span className="wfm-overlap-detail">{overlapClaimants(overlap)}</span>
        </div>
      ))}
      {hidden > 0 && <div className="wfm-overlap wfm-overlap-more">+{hidden} more</div>}
    </div>
  )
}
