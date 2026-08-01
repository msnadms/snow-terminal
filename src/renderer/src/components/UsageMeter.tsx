import { useUsage } from '@renderer/useUsage'

function formatCost(value: number): string {
  if (value >= 100) return `$${Math.round(value)}`
  if (value >= 10) return `$${value.toFixed(1)}`
  return `$${value.toFixed(2)}`
}

function UsageMeter(): React.JSX.Element | null {
  const usage = useUsage()
  if (!usage || usage.error) return null

  return (
    <>
      <div
        className="usage-meter"
        title="Estimated Claude Code usage this snow session (API-rate cost)"
      >
        <span className="usage-meter-value">{formatCost(usage.session)}</span>
        <span className="usage-meter-label">session</span>
      </div>
      <div className="actionbar-divider" />
    </>
  )
}

export default UsageMeter
