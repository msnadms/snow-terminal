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
        title="Estimated Claude Code usage on this machine (API-rate cost, last 24h / 7d)"
      >
        <span className="usage-meter-value">{formatCost(usage.day)}</span>
        <span className="usage-meter-label">day</span>
        <span className="usage-meter-value">{formatCost(usage.week)}</span>
        <span className="usage-meter-label">wk</span>
      </div>
      <div className="actionbar-divider" />
    </>
  )
}

export default UsageMeter
