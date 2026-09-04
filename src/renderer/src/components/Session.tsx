import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Pane, SessionStatus, Split } from '../App'
import { useKeybinds } from '../keybinds'
import { useCollapsiblePane } from '../useCollapsiblePane'
import BrowserTab from './BrowserTab'
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
  bottomTerminalId: number
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
  onStatus: (sessionId: number, terminalStatuses: Record<number, SessionStatus>) => void
  onTitle: (sessionId: number, title: string) => void
  onInterrupt: (sessionId: number, terminalId: number) => void
}

function focusPane(container: Element | null | undefined): void {
  container?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus()
}

function renderSplit(
  split: Split,
  active: boolean,
  onOpenCommit: (cwd: string, hash: string) => void,
  onClose: () => void
): React.JSX.Element {
  switch (split.kind) {
    case 'commit':
      return (
        <CommitView
          active={active}
          cwd={split.cwd}
          hash={split.hash}
          onOpenCommit={onOpenCommit}
          onClose={onClose}
        />
      )
    case 'diff':
      return (
        <WorkingDiffView
          active={active}
          cwd={split.cwd}
          focusKey={0}
          onOpenCommit={onOpenCommit}
          onClose={onClose}
        />
      )
    case 'browser':
      return <BrowserTab id={split.id} initialUrl={split.url} active={active} onClose={onClose} />
  }
}

function Session({
  id,
  bottomTerminalId,
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
  onTitle,
  onInterrupt
}: SessionProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const lastTopRef = useRef(0)

  const [terminalStatuses, setTerminalStatuses] = useState<Record<number, SessionStatus>>({})
  const [wasActive, setWasActive] = useState(active)
  const terminalIds = useMemo(
    () => [...panes.map((pane) => pane.id), bottomTerminalId],
    [panes, bottomTerminalId]
  )
  const paneStatusCbs = useMemo(() => {
    const map: Record<number, (s: 'busy' | 'idle') => void> = {}
    for (const terminalId of terminalIds) {
      map[terminalId] = (reported) =>
        setTerminalStatuses((prev) => {
          const previous = prev[terminalId] ?? 'idle'
          const next =
            reported === 'busy' ? 'busy' : previous === 'busy' && !active ? 'attention' : 'idle'
          return previous === next ? prev : { ...prev, [terminalId]: next }
        })
    }
    return map
  }, [terminalIds, active])

  if (active !== wasActive) {
    setWasActive(active)
    if (active)
      setTerminalStatuses((prev) => {
        let changed = false
        const next = { ...prev }
        for (const terminalId of terminalIds) {
          if (next[terminalId] !== 'attention') continue
          next[terminalId] = 'idle'
          changed = true
        }
        return changed ? next : prev
      })
  }

  const visibleTerminalStatuses = useMemo(
    () =>
      Object.fromEntries(
        terminalIds.map((terminalId) => [terminalId, terminalStatuses[terminalId] ?? 'idle'])
      ),
    [terminalIds, terminalStatuses]
  )
  useEffect(() => {
    onStatus(id, visibleTerminalStatuses)
  }, [id, visibleTerminalStatuses, onStatus])

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
  const handleInterrupt = useCallback(
    (terminalId: number) => {
      setTerminalStatuses((prev) =>
        prev[terminalId] === 'idle' ? prev : { ...prev, [terminalId]: 'idle' }
      )
      onInterrupt(id, terminalId)
    },
    [id, onInterrupt]
  )

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
                terminalId={pane.id}
                cwd={pane.cwd ?? cwd}
                startupCommand={pane.startupCommand ?? startupCommand}
                active={active}
                focusOnActivate={i === 0}
                onStatus={paneStatusCbs[pane.id]}
                onTitle={i === 0 ? handlePrimaryTitle : undefined}
                onInterrupt={() => handleInterrupt(pane.id)}
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
              {renderSplit(split, active, onOpenCommit, () => onCloseSplit(id))}
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
        <Terminal
          terminalId={bottomTerminalId}
          cwd={cwd}
          onCwd={handleBottomCwd}
          onStatus={paneStatusCbs[bottomTerminalId]}
          onInterrupt={() => handleInterrupt(bottomTerminalId)}
          active={active}
        />
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
