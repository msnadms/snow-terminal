import { formatCost } from '@renderer/format'
import { useUsage } from '@renderer/useUsage'

const agentLabels: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

function UsageMeter(): React.JSX.Element | null {
  const usage = useUsage()
  if (!usage || usage.error) return null

  const active = Object.entries(usage.agents).filter(([, cost]) => cost > 0)
  const breakdown =
    active.length > 1
      ? `\n${active
          .map(([agent, cost]) => `${agentLabels[agent] ?? agent}: ${formatCost(cost)}`)
          .join('\n')}`
      : ''

  return (
    <>
      <div
        className="usage-meter"
        title={`Estimated agent usage this snow session (API-rate cost)${breakdown}`}
      >
        <span className="usage-meter-value">{formatCost(usage.session)}</span>
        <span className="usage-meter-label">session</span>
      </div>
      <div className="actionbar-divider" />
    </>
  )
}

export default UsageMeter
