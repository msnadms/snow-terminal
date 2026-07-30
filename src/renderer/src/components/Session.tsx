import { useRef } from 'react'
import type { Pane, Split } from '../App'
import { useKeybinds } from '../keybinds'
import CommitView from './CommitView'
import WorkingDiffView from './WorkingDiffView'
import Terminal from './Terminal'

interface SessionProps {
  active: boolean
  cwd?: string
  panes: Pane[]
  startupCommand: string
  split?: Split
  keybinds: Record<string, string>
  onClosePane: (paneId: number) => void
  onCloseSplit: () => void
  onOpenCommit: (cwd: string, hash: string) => void
  onCwd: (cwd: string) => void
}

function focusPane(container: Element | null | undefined): void {
  container?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus()
}

function Session({
  active,
  cwd,
  panes,
  startupCommand,
  split,
  keybinds,
  onClosePane,
  onCloseSplit,
  onOpenCommit,
  onCwd
}: SessionProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const lastTopRef = useRef(0)

  const navigate = (dir: 'left' | 'right' | 'up' | 'down'): void => {
    const host = hostRef.current
    if (!host) return
    const tops = Array.from(host.querySelectorAll<HTMLElement>('.terminal-main > .terminal-split'))
    const bottom = host.querySelector<HTMLElement>('.terminal-secondary')
    const focused = document.activeElement
    const topIndex = tops.findIndex((el) => el.contains(focused))
    if (topIndex >= 0) {
      lastTopRef.current = topIndex
      if (dir === 'left') focusPane(tops[topIndex - 1])
      else if (dir === 'right') focusPane(tops[topIndex + 1])
      else if (dir === 'down') focusPane(bottom)
      return
    }
    if (bottom?.contains(focused) && dir === 'up') focusPane(tops[lastTopRef.current] ?? tops[0])
  }

  useKeybinds(
    keybinds,
    active
      ? {
          focusLeft: () => navigate('left'),
          focusDown: () => navigate('down'),
          focusUp: () => navigate('up'),
          focusRight: () => navigate('right')
        }
      : {}
  )

  return (
    <div className="terminal-host" ref={hostRef} style={{ display: active ? 'flex' : 'none' }}>
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
