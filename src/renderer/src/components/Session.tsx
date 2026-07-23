import Terminal from './Terminal'

interface SessionProps {
  active: boolean
  cwd?: string
  onCwd: (cwd: string) => void
}

function Session({ active, cwd, onCwd }: SessionProps): React.JSX.Element {
  return (
    <div className="terminal-host" style={{ display: active ? 'flex' : 'none' }}>
      <div className="terminal-main">
        <Terminal cwd={cwd} startupCommand="claude" active={active} focusOnActivate />
      </div>
      <div className="terminal-secondary">
        <Terminal cwd={cwd} onCwd={onCwd} active={active} />
      </div>
    </div>
  )
}

export default Session
