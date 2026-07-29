import { useEffect, useMemo, useRef, useState } from 'react'
import ActionBar from './components/ActionBar'
import CommitView from './components/CommitView'
import GitPanel, { type GitRepo } from './components/GitPanel'
import Session from './components/Session'
import BrowserTab from './components/BrowserTab'
import TabBar from './components/TabBar'
import HomePage from './components/HomePage'
import Tour from './components/Tour'
import WorkingDiffView from './components/WorkingDiffView'
import { basename, shortHash, uniqueBy } from './format'
import { nextTerminalId } from './terminalId'
import { useSnowconfig, type Preset } from './useSnowconfig'

type ActiveId = number | 'home'

export type Split = { kind: 'commit'; cwd: string; hash: string } | { kind: 'diff'; cwd: string }

export type Pane = { id: number; cwd?: string; startupCommand?: string }

type Tab =
  | { kind: 'shell'; id: number; cwd?: string; startupCommand?: string }
  | { kind: 'commit'; id: number; cwd: string; hash: string }
  | { kind: 'diff'; id: number; cwd: string; branch: string; focus?: string; focusKey: number }
  | { kind: 'browser'; id: number; url: string }

function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<ActiveId>('home')
  const [cwds, setCwds] = useState<Record<number, string | undefined>>({})
  const [panes, setPanes] = useState<Record<number, Pane[]>>({})
  const [splits, setSplits] = useState<Record<number, Split>>({})
  const [running, setRunning] = useState<Record<string, number>>({})
  const [browserTitles, setBrowserTitles] = useState<Record<number, string>>({})
  const [frozen, setFrozen] = useState<{ entries: { cwd: string; presetCwd?: string }[] } | null>(
    null
  )
  const [tour, setTour] = useState(false)
  const nextIdRef = useRef(1)
  const {
    presets,
    name: configName,
    startupCommand,
    gradients,
    theme: themeName,
    tourSeen,
    error: presetsError
  } = useSnowconfig()

  const activeTab = tabs.find((t) => t.id === activeId)
  const cwd =
    activeTab && (activeTab.kind === 'commit' || activeTab.kind === 'diff')
      ? activeTab.cwd
      : cwds[activeTab?.id ?? -1]
  const repoEntries = useMemo<{ cwd: string; presetCwd?: string }[]>(() => {
    if (!activeTab) return cwd != null ? [{ cwd }] : []
    if (activeTab.kind === 'commit' || activeTab.kind === 'diff')
      return [{ cwd: activeTab.cwd, presetCwd: activeTab.cwd }]
    if (activeTab.kind === 'browser') return []
    const sessionPanes = panes[activeTab.id] ?? []
    const base = activeTab.cwd ?? cwds[activeTab.id]
    const pairs: { cwd: string; presetCwd?: string }[] = []
    if (base != null) pairs.push({ cwd: base, presetCwd: activeTab.cwd })
    for (const pane of sessionPanes) {
      if (pane.cwd != null) pairs.push({ cwd: pane.cwd, presetCwd: pane.cwd })
    }
    return uniqueBy(pairs, (entry) => entry.cwd)
  }, [activeTab, cwd, cwds, panes])

  const activeEntries = frozen ? frozen.entries : repoEntries
  const discoverKey = activeEntries.map((entry) => entry.cwd).join('\n')

  const [repos, setRepos] = useState<GitRepo[] | null>(null)
  useEffect(() => {
    let cancelled = false
    const cwds = discoverKey ? discoverKey.split('\n') : [undefined]
    Promise.all(cwds.map((cwd) => window.api.git.discover(cwd).catch(() => [])))
      .then((results) => {
        if (!cancelled) setRepos(uniqueBy(results.flat(), (repo) => repo.path))
      })
      .catch(() => {
        if (!cancelled) setRepos([])
      })
    return () => {
      cancelled = true
    }
  }, [discoverKey])

  const actionRepos = useMemo(() => {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
    return (repos ?? []).map((repo) => {
      const root = norm(repo.path)
      const owner = activeEntries.find((entry) => {
        const c = norm(entry.cwd)
        return c === root || c.startsWith(root + '/')
      })
      return { cwd: repo.path, name: repo.name, presetCwd: owner?.presetCwd }
    })
  }, [repos, activeEntries])

  const [pickedRepo, setPickedRepo] = useState<string | null>(null)
  const repoIndex = Math.max(
    0,
    actionRepos.findIndex((e) => e.cwd === pickedRepo)
  )
  const activeRepo = actionRepos[repoIndex]
  const actionCwd = activeRepo?.cwd
  const switchRepo = (): void => {
    if (actionRepos.length < 2) return
    setPickedRepo(actionRepos[(repoIndex + 1) % actionRepos.length].cwd)
  }

  const activePresetCwd = activeRepo?.presetCwd
  const activePresetIndex =
    activePresetCwd != null ? presets.findIndex((p) => p.cwd === activePresetCwd) : -1
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
      if (tab.kind === 'browser') {
        result[tab.id] = browserTitles[tab.id] ?? 'Browser'
        continue
      }
      const dir = cwds[tab.id]
      if (dir) result[tab.id] = basename(dir)
    }
    return result
  }, [tabs, cwds, browserTitles])

  const addSession = (cwd?: string, startupCommand?: string): void => {
    const id = nextIdRef.current++
    setTabs((prev) => [...prev, { kind: 'shell', id, cwd, startupCommand }])
    if (cwd) setCwds((prev) => ({ ...prev, [id]: cwd }))
    setPanes((prev) => ({ ...prev, [id]: [{ id: nextTerminalId() }] }))
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

  const openBrowser = (url = 'https://www.google.com'): void => {
    const id = nextIdRef.current++
    setTabs((prev) => [...prev, { kind: 'browser', id, url }])
    setActiveId(id)
  }

  const splitActive = (preset?: Preset): void => {
    if (!activeTab || activeTab.kind !== 'shell') return
    const paneId = nextTerminalId()
    const pane: Pane = preset
      ? { id: paneId, cwd: preset.cwd, startupCommand: preset.startupCommand }
      : { id: paneId }
    setPanes((prev) => ({ ...prev, [activeTab.id]: [...(prev[activeTab.id] ?? []), pane] }))
  }

  const openSplit = (split: Split): void => {
    if (!activeTab || activeTab.kind !== 'shell') return
    setSplits((prev) => ({ ...prev, [activeTab.id]: split }))
  }

  const openCommitSplit = (cwd: string, hash: string): void => {
    openSplit({ kind: 'commit', cwd, hash })
  }

  const openDiffSplit = (cwd: string): void => {
    openSplit({ kind: 'diff', cwd })
  }

  const closeSplit = (sessionId: number): void => {
    setSplits((prev) => {
      if (!(sessionId in prev)) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }

  const closePane = (sessionId: number, paneId: number): void => {
    setPanes((prev) => {
      const current = prev[sessionId]
      if (!current || current.length <= 1) return prev
      return { ...prev, [sessionId]: current.filter((p) => p.id !== paneId) }
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
    return window.api.terminal.onExit(null, (id) => {
      setRunning((prev) => {
        const command = Object.keys(prev).find((key) => prev[key] === id)
        if (command === undefined) return prev
        const next = { ...prev }
        delete next[command]
        return next
      })
    })
  }, [])

  useEffect(() => {
    if (tourSeen) return
    if (activeTab?.kind !== 'shell' || !cwd) return
    let cancelled = false
    window.api.git.isRepo(cwd).then((repo) => {
      if (!cancelled && repo) setTour(true)
    })
    return () => {
      cancelled = true
    }
  }, [tourSeen, activeTab?.kind, cwd])

  const closeTour = (): void => {
    window.api.snowconfig.setTourSeen()
    setTour(false)
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
    const dropKey = <T,>(prev: Record<number, T>): Record<number, T> => {
      const next = { ...prev }
      delete next[id]
      return next
    }
    setCwds(dropKey)
    setPanes(dropKey)
    setSplits(dropKey)
    setBrowserTitles(dropKey)
  }

  return (
    <div className="app">
      <ActionBar
        cwd={actionCwd}
        repoName={activeRepo?.name}
        repoCount={actionRepos.length}
        onSwitchRepo={switchRepo}
        frozen={frozen !== null}
        onFreeze={(on) => setFrozen(on ? { entries: repoEntries } : null)}
        onOpenPullRequest={(url) => openBrowser(url)}
      />
      <div className="content">
        <div className="terminal-area">
          <TabBar
            sessions={tabs}
            activeId={activeId}
            labels={labels}
            onSelect={setActiveId}
            onClose={closeSession}
            onAdd={() => {
              const preset = presets.find((p) => p.default)
              addSession(preset?.cwd, preset?.startupCommand)
            }}
            onOpenBrowser={() => openBrowser()}
            onSplit={() => splitActive()}
            presets={presets}
            onSplitWithPreset={(preset) => splitActive(preset)}
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
            <HomePage
              active={activeId === 'home'}
              presets={presets}
              name={configName}
              theme={themeName ?? 'theme'}
              error={presetsError}
              onOpenPreset={addSession}
            />
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
              if (tab.kind === 'browser')
                return (
                  <BrowserTab
                    key={tab.id}
                    id={tab.id}
                    initialUrl={tab.url}
                    active={activeId === tab.id}
                    onTitle={(title) => setBrowserTitles((prev) => ({ ...prev, [tab.id]: title }))}
                  />
                )
              return (
                <Session
                  key={tab.id}
                  active={activeId === tab.id}
                  cwd={tab.cwd}
                  panes={panes[tab.id] ?? []}
                  startupCommand={tab.startupCommand ?? startupCommand ?? 'claude'}
                  split={splits[tab.id]}
                  onCloseSplit={() => closeSplit(tab.id)}
                  onOpenCommit={openCommit}
                  onClosePane={(paneId) => closePane(tab.id, paneId)}
                  onCwd={(next) => setCwds((prev) => ({ ...prev, [tab.id]: next }))}
                />
              )
            })}
          </div>
        </div>
        <GitPanel
          repos={repos}
          gradients={gradients}
          onOpenCommit={openCommit}
          onOpenCommitSplit={activeTab?.kind === 'shell' ? openCommitSplit : undefined}
          onOpenDiff={openDiff}
          onOpenDiffSplit={activeTab?.kind === 'shell' ? openDiffSplit : undefined}
        />
      </div>
      {tour && <Tour onClose={closeTour} />}
    </div>
  )
}

export default App
