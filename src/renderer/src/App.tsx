import { useEffect, useMemo, useRef, useState } from 'react'
import ActionBar from './components/ActionBar'
import CommitView from './components/CommitView'
import GitPanel from './components/GitPanel'
import Session from './components/Session'
import TabBar from './components/TabBar'
import HomePage from './components/HomePage'
import WorkingDiffView from './components/WorkingDiffView'
import { basename, shortHash } from './format'
import { nextTerminalId } from './terminalId'
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
  const [panes, setPanes] = useState<Record<number, number[]>>({})
  const [running, setRunning] = useState<Record<string, number>>({})
  const [frozen, setFrozen] = useState<{ cwd?: string } | null>(null)
  const nextIdRef = useRef(1)
  const { presets, name: configName, startupCommand, error: presetsError } = useSnowconfig()

  const activeTab = tabs.find((t) => t.id === activeId)
  const cwd = activeTab && activeTab.kind !== 'shell' ? activeTab.cwd : cwds[activeTab?.id ?? -1]
  const gitCwd = frozen ? frozen.cwd : cwd

  const activeShellCwd = activeTab?.kind === 'shell' ? activeTab.cwd : undefined
  const activePresetIndex =
    activeShellCwd != null ? presets.findIndex((p) => p.cwd === activeShellCwd) : -1
  const activePreset = activePresetIndex >= 0 ? presets[activePresetIndex] : undefined
  const presetCommands = activePreset?.commands ?? []
  const runKey = (presetCwd: string, command: string): string => `${presetCwd}\n${command}`
  const runningCommands = activePreset
    ? presetCommands.filter((c) => running[runKey(activePreset.cwd, c)] != null)
    : []

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
    setPanes((prev) => ({ ...prev, [id]: [nextTerminalId()] }))
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

  const splitActive = (): void => {
    if (!activeTab || activeTab.kind !== 'shell') return
    const paneId = nextTerminalId()
    setPanes((prev) => ({ ...prev, [activeTab.id]: [...(prev[activeTab.id] ?? []), paneId] }))
  }

  const closePane = (sessionId: number, paneId: number): void => {
    setPanes((prev) => {
      const current = prev[sessionId]
      if (!current || current.length <= 1) return prev
      return { ...prev, [sessionId]: current.filter((p) => p !== paneId) }
    })
  }

  const toggleCommand = (command: string): void => {
    if (!activePreset) return
    const key = runKey(activePreset.cwd, command)
    const existing = running[key]
    if (existing != null) {
      window.api.terminal.kill(existing)
      setRunning((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      return
    }
    const id = nextTerminalId()
    window.api.terminal.spawn(id, 80, 24, activePreset.cwd, `${command}; exit`)
    setRunning((prev) => ({ ...prev, [key]: id }))
  }

  useEffect(() => {
    return window.api.terminal.onExit((id) => {
      setRunning((prev) => {
        const command = Object.keys(prev).find((key) => prev[key] === id)
        if (command === undefined) return prev
        const next = { ...prev }
        delete next[command]
        return next
      })
    })
  }, [])

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
    setPanes((prev) => {
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
            onSplit={splitActive}
            onToggleCommand={toggleCommand}
            onAddCommand={(command) => {
              if (activePresetIndex >= 0)
                window.api.snowconfig.addCommand(activePresetIndex, command)
            }}
            onRemoveCommand={(index) => {
              if (activePresetIndex >= 0)
                window.api.snowconfig.removeCommand(activePresetIndex, index)
            }}
            commands={presetCommands}
            runningCommands={runningCommands}
            canManageCommands={activePresetIndex >= 0}
            canSplit={activeTab?.kind === 'shell'}
          />
          <div className="terminal-stack">
            {activeId === 'home' && (
              <HomePage
                presets={presets}
                name={configName}
                error={presetsError}
                onOpenPreset={(dir) => addSession(dir)}
              />
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
                  paneIds={panes[tab.id] ?? []}
                  startupCommand={startupCommand ?? 'claude'}
                  onClosePane={(paneId) => closePane(tab.id, paneId)}
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
