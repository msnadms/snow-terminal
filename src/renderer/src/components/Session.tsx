import Terminal from './Terminal'

interface SessionProps {
  active: boolean
  onCwd: (cwd: string) => void
}

function Session({ active, onCwd }: SessionProps): React.JSX.Element {
  return (
    <div className="terminal-host" style={{ display: active ? 'flex' : 'none' }}>
      <div className="terminal-main">
        <Terminal startupCommand="claude" active={active} focusOnActivate />
      </div>
      <div className="terminal-secondary">
        <Terminal onCwd={onCwd} active={active} />
      </div>
    </div>
  )
}

export default Session
