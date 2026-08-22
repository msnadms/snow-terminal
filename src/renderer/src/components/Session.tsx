import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Pane, SessionStatus, Split } from '../App'
import { useKeybinds } from '../keybinds'
import { useCollapsiblePane } from '../useCollapsiblePane'
import CommitView from './CommitView'
import PanelRestore from './PanelRestore'
import ResizeHandle from './ResizeHandle'
import WorkingDiffView from './WorkingDiffView'
import Terminal from './Terminal'

const MIN_PANE = 120
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
  savedPaneRatios?: number[]
  onBottomLayout: (height: number, collapsed: boolean) => void
  onPaneRatios: (sessionId: number, ratios: number[]) => void
  onClosePane: (sessionId: number, paneId: number) => void
  onCloseSplit: (sessionId: number) => void
  onOpenCommit: (cwd: string, hash: string) => void
  onCwd: (sessionId: number, cwd: string) => void
  onStatus: (sessionId: number, status: SessionStatus) => void
  onTitle: (sessionId: number, title: string) => void
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
  savedPaneRatios,
  onBottomLayout,
  onPaneRatios,
  onClosePane,
  onCloseSplit,
  onOpenCommit,
  onCwd,
  onStatus,
  onTitle
}: SessionProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const lastTopRef = useRef(0)

  const [paneStatuses, setPaneStatuses] = useState<Record<number, 'busy' | 'idle'>>({})
  const paneStatusCbs = useMemo(() => {
    const map: Record<number, (s: 'busy' | 'idle') => void> = {}
    for (const pane of panes) {
      map[pane.id] = (s) =>
        setPaneStatuses((prev) => (prev[pane.id] === s ? prev : { ...prev, [pane.id]: s }))
    }
    return map
  }, [panes])

  const busy = panes.some((p) => paneStatuses[p.id] === 'busy')
  const [attention, setAttention] = useState(false)
  const [prevBusy, setPrevBusy] = useState(busy)
  const [wasActive, setWasActive] = useState(active)

  if (busy !== prevBusy) {
    setPrevBusy(busy)
    if (!busy && !active) setAttention(true)
  }
  if (active !== wasActive) {
    setWasActive(active)
    if (active) setAttention(false)
  }

  const status: SessionStatus = busy ? 'busy' : attention ? 'attention' : 'idle'
  useEffect(() => {
    onStatus(id, status)
  }, [id, status, onStatus])

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
  const handlePrimaryTitle = useCallback((next: string) => onTitle(id, next), [onTitle, id])

  const savedGrows: Record<string, number> = {}
  if (savedPaneRatios && savedPaneRatios.length === panes.length) {
    const total = savedPaneRatios.reduce((a, b) => a + b, 0)
    panes.forEach((pane, i) => {
      savedGrows[String(pane.id)] = (savedPaneRatios[i] / total) * panes.length
    })
  }

  const keys = [...panes.map((p) => String(p.id)), ...(split ? ['diff'] : [])]
  const sig = keys.join(',')
  const growValues = grows.sig === sig ? grows.values : savedGrows

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
    const na = Math.max(MIN_PANE, Math.min(total - MIN_PANE, base[a] + delta))
    setGrows({ sig, values: { ...base, [a]: na, [b]: total - na } })
  }

  const persistRatios = (): void => {
    if (panes.length < 2) return
    const widths = measure()
    const values = panes.map((p) => widths[String(p.id)])
    if (values.some((v) => !(v > 0))) return
    const total = values.reduce((a, b) => a + b, 0)
    onPaneRatios(
      id,
      values.map((v) => Math.round((v / total) * 1000) / 1000)
    )
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
                onEnd={persistRatios}
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
                onStatus={paneStatusCbs[pane.id]}
                onTitle={i === 0 ? handlePrimaryTitle : undefined}
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
              onEnd={persistRatios}
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
