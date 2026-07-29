import type { Pane, Split } from '../App'
import CommitView from './CommitView'
import WorkingDiffView from './WorkingDiffView'
import Terminal from './Terminal'

interface SessionProps {
  active: boolean
  cwd?: string
  panes: Pane[]
  startupCommand: string
  split?: Split
  onClosePane: (paneId: number) => void
  onCloseSplit: () => void
  onOpenCommit: (cwd: string, hash: string) => void
  onCwd: (cwd: string) => void
}

function Session({
  active,
  cwd,
  panes,
  startupCommand,
  split,
  onClosePane,
  onCloseSplit,
  onOpenCommit,
  onCwd
}: SessionProps): React.JSX.Element {
  return (
    <div className="terminal-host" style={{ display: active ? 'flex' : 'none' }}>
      <div className="terminal-main">
        {panes.map((pane, i) => (
          <div className="terminal-split" key={pane.id}>
            {panes.length > 1 && (
              <button
                className="terminal-close"
                onClick={() => onClosePane(pane.id)}
                title="Close terminal"
              >
                
              </button>
            )}
            <Terminal
              cwd={pane.cwd ?? cwd}
              startupCommand={pane.startupCommand ?? startupCommand}
              active={active}
              focusOnActivate={i === 0}
            />
          </div>
        ))}
        {split && (
          <div className="terminal-diff-split">
            {split.kind === 'commit' ? (
              <CommitView
                active={active}
                cwd={split.cwd}
                hash={split.hash}
                onOpenCommit={onOpenCommit}
                onClose={onCloseSplit}
              />
            ) : (
              <WorkingDiffView
                active={active}
                cwd={split.cwd}
                focusKey={0}
                onOpenCommit={onOpenCommit}
                onClose={onCloseSplit}
              />
            )}
          </div>
        )}
      </div>
      <div className="terminal-secondary">
        <Terminal cwd={cwd} onCwd={onCwd} active={active} />
      </div>
    </div>
  )
}

export default Session
