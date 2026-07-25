import Terminal from './Terminal'

interface SessionProps {
  active: boolean
  cwd?: string
  paneIds: number[]
  startupCommand: string
  onClosePane: (paneId: number) => void
  onCwd: (cwd: string) => void
}

function Session({
  active,
  cwd,
  paneIds,
  startupCommand,
  onClosePane,
  onCwd
}: SessionProps): React.JSX.Element {
  return (
    <div className="terminal-host" style={{ display: active ? 'flex' : 'none' }}>
      <div className="terminal-main">
        {paneIds.map((id, i) => (
          <div className="terminal-split" key={id}>
            {paneIds.length > 1 && (
              <button
                className="terminal-close"
                onClick={() => onClosePane(id)}
                title="Close terminal"
              >
                
              </button>
            )}
            <Terminal
              cwd={cwd}
              startupCommand={startupCommand}
              active={active}
              focusOnActivate={i === 0}
            />
          </div>
        ))}
      </div>
      <div className="terminal-secondary">
        <Terminal cwd={cwd} onCwd={onCwd} active={active} />
      </div>
    </div>
  )
}

export default Session
