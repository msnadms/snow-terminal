import { useMemo, useRef, useState } from 'react'
import ActionBar from './components/ActionBar'
import CommitView from './components/CommitView'
import GitPanel from './components/GitPanel'
import Session from './components/Session'
import TabBar from './components/TabBar'
import HomePage from './components/HomePage'
import WorkingDiffView from './components/WorkingDiffView'
import { basename, shortHash } from './format'
import { useSnowconfig } from './useSnowconfig'

type ActiveId = number | 'home'

type Tab =
  | { kind: 'shell'; id: number; cwd?: string }
  | { kind: 'commit'; id: number; cwd: string; hash: string }
  | { kind: 'diff'; id: number; cwd: string; branch: string; focus?: string; focusKey: number }

function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<ActiveId>('home')
  const [cwds, setCwds] = useState<Record<number, string | undefined>>({})
  const [frozen, setFrozen] = useState<{ cwd?: string } | null>(null)
  const nextIdRef = useRef(1)
  const presets = useSnowconfig()

  const activeTab = tabs.find((t) => t.id === activeId)
  const cwd = activeTab && activeTab.kind !== 'shell' ? activeTab.cwd : cwds[activeTab?.id ?? -1]
  const gitCwd = frozen ? frozen.cwd : cwd

  const labels = useMemo(() => {
    const result: Record<number, string> = {}
    for (const tab of tabs) {
      if (tab.kind === 'commit') {
        result[tab.id] = shortHash(tab.hash)
        continue
      }
      if (tab.kind === 'diff') {
        result[tab.id] = `${tab.branch} ✎`
        continue
      }
      const dir = cwds[tab.id]
      if (dir) result[tab.id] = basename(dir)
    }
    return result
  }, [tabs, cwds])

  const addSession = (cwd?: string): void => {
    const id = nextIdRef.current++
    setTabs((prev) => [...prev, { kind: 'shell', id, cwd }])
    if (cwd) setCwds((prev) => ({ ...prev, [id]: cwd }))
    setActiveId(id)
  }

  const openCommit = (cwd: string, hash: string): void => {
    const existing = tabs.find((t) => t.kind === 'commit' && t.cwd === cwd && t.hash === hash)
    if (existing) {
      setActiveId(existing.id)
      return
    }
    const id = nextIdRef.current++
    setTabs((prev) => [...prev, { kind: 'commit', id, cwd, hash }])
    setActiveId(id)
  }

  const openDiff = (cwd: string, branch: string, file?: string): void => {
    const existing = tabs.find((t) => t.kind === 'diff' && t.cwd === cwd)
    if (existing) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === existing.id && t.kind === 'diff'
            ? { ...t, branch, focus: file, focusKey: t.focusKey + 1 }
            : t
        )
      )
      setActiveId(existing.id)
      return
    }
    const id = nextIdRef.current++
    setTabs((prev) => [...prev, { kind: 'diff', id, cwd, branch, focus: file, focusKey: 0 }])
    setActiveId(id)
  }

  const closeSession = (id: number): void => {
    const index = tabs.findIndex((t) => t.id === id)
    if (index === -1) return
    const remaining = tabs.filter((t) => t.id !== id)
    if (activeId === id) {
      const neighbor = remaining[index - 1] ?? remaining[index]
      setActiveId(neighbor ? neighbor.id : 'home')
    }
    setTabs(remaining)
    setCwds((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  return (
    <div className="app">
      <ActionBar
        cwd={cwd}
        frozen={frozen !== null}
        onFreeze={(on) => setFrozen(on ? { cwd } : null)}
      />
      <div className="content">
        <div className="terminal-area">
          <TabBar
            sessions={tabs}
            activeId={activeId}
            labels={labels}
            onSelect={setActiveId}
            onClose={closeSession}
            onAdd={() => addSession(presets.find((p) => p.default)?.cwd)}
          />
          <div className="terminal-stack">
            {activeId === 'home' && (
              <HomePage presets={presets} onOpenPreset={(dir) => addSession(dir)} />
            )}
            {tabs.map((tab) => {
              if (tab.kind === 'commit')
                return (
                  <CommitView
                    key={tab.id}
                    active={activeId === tab.id}
                    cwd={tab.cwd}
                    hash={tab.hash}
                    onOpenCommit={openCommit}
                  />
                )
              if (tab.kind === 'diff')
                return (
                  <WorkingDiffView
                    key={tab.id}
                    active={activeId === tab.id}
                    cwd={tab.cwd}
                    focus={tab.focus}
                    focusKey={tab.focusKey}
                    onOpenCommit={openCommit}
                  />
                )
              return (
                <Session
                  key={tab.id}
                  active={activeId === tab.id}
                  cwd={tab.cwd}
                  onCwd={(next) => setCwds((prev) => ({ ...prev, [tab.id]: next }))}
                />
              )
            })}
          </div>
        </div>
        <GitPanel cwd={gitCwd} onOpenCommit={openCommit} onOpenDiff={openDiff} />
      </div>
    </div>
  )
}

export default App
