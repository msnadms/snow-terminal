import { Fragment, memo, useCallback, useRef, useState } from 'react'
import type { Pane, Split } from '../App'
import { useKeybinds } from '../keybinds'
import { useCollapsiblePane } from '../useCollapsiblePane'
import CommitView from './CommitView'
import PanelRestore from './PanelRestore'
import ResizeHandle from './ResizeHandle'
import WorkingDiffView from './WorkingDiffView'
import Terminal from './Terminal'

const MIN_PANE = 120
const PANE_COLLAPSE = 60
const MIN_MAIN = 120
const MIN_BOTTOM = 80
const BOTTOM_COLLAPSE = 40

interface SessionProps {
  id: number
  active: boolean
  cwd?: string
  panes: Pane[]
  startupCommand: string
  split?: Split
  keybinds: Record<string, string>
  savedBottomHeight?: number
  savedBottomCollapsed?: boolean
  onBottomLayout: (height: number, collapsed: boolean) => void
  onClosePane: (sessionId: number, paneId: number) => void
  onCloseSplit: (sessionId: number) => void
  onOpenCommit: (cwd: string, hash: string) => void
  onCwd: (sessionId: number, cwd: string) => void
}

function focusPane(container: Element | null | undefined): void {
  container?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus()
}

function Session({
  id,
  active,
  cwd,
  panes,
  startupCommand,
  split,
  keybinds,
  savedBottomHeight,
  savedBottomCollapsed,
  onBottomLayout,
  onClosePane,
  onCloseSplit,
  onOpenCommit,
  onCwd
}: SessionProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const lastTopRef = useRef(0)

  const [grows, setGrows] = useState<{ sig: string; values: Record<string, number> }>({
    sig: '',
    values: {}
  })
  const baseGrows = useRef<Record<string, number>>({})

  const bottom = useCollapsiblePane({
    min: MIN_BOTTOM,
    collapseAt: BOTTOM_COLLAPSE,
    defaultSize: 160,
    savedSize: savedBottomHeight,
    savedCollapsed: savedBottomCollapsed,
    maxSize: () => {
      const host = hostRef.current
      return host ? host.clientHeight - MIN_MAIN : Number.POSITIVE_INFINITY
    },
    persist: onBottomLayout
  })

  const handleBottomCwd = useCallback((next: string) => onCwd(id, next), [onCwd, id])

  const keys = [...panes.map((p) => String(p.id)), ...(split ? ['diff'] : [])]
  const sig = keys.join(',')
  const growValues = grows.sig === sig ? grows.values : {}

  const measure = (): Record<string, number> => {
    const el = mainRef.current
    const result: Record<string, number> = {}
    if (!el) return result
    const kids = Array.from(el.children).filter(
      (c) => !c.classList.contains('resize-handle')
    ) as HTMLElement[]
    kids.forEach((c, i) => {
      if (keys[i] != null) result[keys[i]] = c.getBoundingClientRect().width
    })
    return result
  }

  const resizeSplit = (i: number, delta: number): void => {
    const base = baseGrows.current
    const a = keys[i]
    const b = keys[i + 1]
    if (a == null || b == null || base[a] == null || base[b] == null) return
    const total = base[a] + base[b]
    let na = Math.max(0, Math.min(total, base[a] + delta))
    if (na < base[a]) {
      if (na < PANE_COLLAPSE) na = 0
      else if (na < MIN_PANE) na = MIN_PANE
    } else if (na > base[a]) {
      const nb = total - na
      if (nb < PANE_COLLAPSE) na = total
      else if (nb < MIN_PANE) na = total - MIN_PANE
    }
    setGrows({ sig, values: { ...base, [a]: na, [b]: total - na } })
  }

  const navigate = (dir: 'left' | 'right' | 'up' | 'down'): void => {
    const host = hostRef.current
    if (!host) return
    const tops = Array.from(host.querySelectorAll<HTMLElement>('.terminal-main > .terminal-split'))
    const bottomEl = host.querySelector<HTMLElement>('.terminal-secondary')
    const focused = document.activeElement
    const topIndex = tops.findIndex((el) => el.contains(focused))
    if (topIndex >= 0) {
      lastTopRef.current = topIndex
      if (dir === 'left') focusPane(tops[topIndex - 1])
      else if (dir === 'right') focusPane(tops[topIndex + 1])
      else if (dir === 'down') focusPane(bottomEl)
      return
    }
    if (bottomEl?.contains(focused) && dir === 'up') focusPane(tops[lastTopRef.current] ?? tops[0])
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
      <div className="terminal-main" ref={mainRef}>
        {panes.map((pane, i) => (
          <Fragment key={pane.id}>
            {i > 0 && (
              <ResizeHandle
                axis="x"
                onStart={() => (baseGrows.current = measure())}
                onResize={(d) => resizeSplit(i - 1, d)}
              />
            )}
            <div className="terminal-split" style={{ flexGrow: growValues[String(pane.id)] }}>
              {panes.length > 1 && (
                <button
                  className="terminal-close"
                  onClick={() => onClosePane(id, pane.id)}
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
          </Fragment>
        ))}
        {split && (
          <>
            <ResizeHandle
              axis="x"
              onStart={() => (baseGrows.current = measure())}
              onResize={(d) => resizeSplit(panes.length - 1, d)}
            />
            <div className="terminal-diff-split" style={{ flexGrow: growValues['diff'] }}>
              {split.kind === 'commit' ? (
                <CommitView
                  active={active}
                  cwd={split.cwd}
                  hash={split.hash}
                  onOpenCommit={onOpenCommit}
                  onClose={() => onCloseSplit(id)}
                />
              ) : (
                <WorkingDiffView
                  active={active}
                  cwd={split.cwd}
                  focusKey={0}
                  onOpenCommit={onOpenCommit}
                  onClose={() => onCloseSplit(id)}
                />
              )}
            </div>
          </>
        )}
      </div>
      {!bottom.collapsed && (
        <ResizeHandle
          axis="y"
          onStart={bottom.onStart}
          onResize={bottom.onResize}
          onEnd={bottom.onEnd}
        />
      )}
      <div
        className={`terminal-secondary${bottom.collapsed ? ' terminal-secondary-collapsed' : ''}`}
        style={{ flexBasis: bottom.collapsed ? 0 : bottom.size }}
      >
        <Terminal cwd={cwd} onCwd={handleBottomCwd} active={active} />
      </div>
      {bottom.collapsed && (
        <PanelRestore
          className="panel-restore-bottom"
          label="󰞙"
          title="Show terminal"
          onClick={bottom.restore}
        />
      )}
    </div>
  )
}

export default memo(Session)
