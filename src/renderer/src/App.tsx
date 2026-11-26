import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ActionBar from './components/ActionBar'
import CommitView from './components/CommitView'
import GitPanel from './components/GitPanel'
import Session from './components/Session'
import BrowserTab from './components/BrowserTab'
import TabBar from './components/TabBar'
import HomePage from './components/HomePage'
import ResizeHandle from './components/ResizeHandle'
import PanelRestore from './components/PanelRestore'
import Tour from './components/Tour'
import WorkflowManager from './components/WorkflowManager'
import WorkingDiffView from './components/WorkingDiffView'
import FailureDialog from './components/FailureDialog'
import PaneBoundary from './components/PaneBoundary'
import { normalizePath } from './format'
import { nextTerminalId } from './terminalId'
import { regroupTabs } from './tabGroups'
import { useKeybinds, usePresetDigitKeybind } from './keybinds'
import { useAgents, type AgentSession } from './useAgents'
import { useAppNotices } from './useAppNotices'
import { useCollapsiblePane } from './useCollapsiblePane'
import { useRepoDiscovery } from './useRepoDiscovery'
import { useRunningCommands } from './useRunningCommands'
import { useSnowconfig, visiblePresetEntries, type Preset } from './useSnowconfig'
import { useTabGroups } from './useTabGroups'
import type { WorkflowReviewTarget } from './workflowRows'
import {
  actionReposOf,
  commandItemsOf,
  commandPresetsOf,
  inheritedPreset,
  mergeCodeLinks,
  mergeTurns,
  panelViewFor,
  moveTab,
  moveTabGroup,
  openSessionsOf,
  presetIndexFor,
  repoEntriesOf,
  sessionStatusesOf,
  shellTerminals,
  tabCwdOf,
  tabLabels,
  type ActiveId,
  type TabTurn,
  type AppPage,
  type CodeLinkTarget,
  type CommandItem,
  type Overlay,
  type Pane,
  type PanelChoice,
  type PanelView,
  type RepoEntry,
  type Split,
  type Tab,
  type TabCodeLinks,
  type TerminalStatuses
} from './appModel'
import {
  agentDirsOf,
  terminalAgentsOf,
  visibleAgentSessions,
  workflowSessionsOf,
  type SessionStatus
} from './agentStatus'

const GIT_MIN = 220
const GIT_COLLAPSE = 120

function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<ActiveId>('home')
  const [cwds, setCwds] = useState<Record<number, string | undefined>>({})
  const [panes, setPanes] = useState<Record<number, Pane[]>>({})
  const [splits, setSplits] = useState<Record<number, Split>>({})
  const [overlays, setOverlays] = useState<Record<number, Overlay>>({})
  const [codeLinks, setCodeLinks] = useState<Record<number, TabCodeLinks>>({})
  const [turns, setTurns] = useState<Record<number, TabTurn>>({})
  const [panelChoices, setPanelChoices] = useState<Record<number, PanelChoice>>({})
  const [browserTitles, setBrowserTitles] = useState<Record<number, string>>({})
  const [terminalStatuses, setTerminalStatuses] = useState<TerminalStatuses>({})
  const [titles, setTitles] = useState<Record<number, string>>({})
  const [interruptedTerminals, setInterruptedTerminals] = useState<Record<number, number>>({})
  const [frozen, setFrozen] = useState<{ entries: RepoEntry[] } | null>(null)
  const [tourDismissed, setTourDismissed] = useState(false)
  const [pickedRepo, setPickedRepo] = useState<string | null>(null)
  const [notice, setNotice] = useAppNotices()
  const { running, toggleCommand } = useRunningCommands()
  const gitPanelRef = useRef<HTMLDivElement>(null)
  const nextIdRef = useRef(1)
  const tabsRef = useRef(tabs)
  const activeIdRef = useRef(activeId)
  const lastVisitedRef = useRef<AppPage>('home')
  const cwdsRef = useRef(cwds)
  useEffect(() => {
    tabsRef.current = tabs
    activeIdRef.current = activeId
    if (typeof activeId === 'string') lastVisitedRef.current = activeId
    cwdsRef.current = cwds
  }, [tabs, activeId, cwds])
  const {
    presets,
    name: configName,
    startupCommand,
    gradients,
    theme: themeName,
    tourSeen,
    hooksPrompted,
    keybinds,
    layout,
    workspaceOrder,
    setWorkspaceOrder,
    error: presetsError
  } = useSnowconfig()
  const visiblePresets = useMemo(
    () => visiblePresetEntries(presets).map((e) => e.preset),
    [presets]
  )

  const gitPane = useCollapsiblePane({
    min: GIT_MIN,
    collapseAt: GIT_COLLAPSE,
    defaultSize: 320,
    savedSize: layout.gitWidth,
    savedCollapsed: layout.gitCollapsed,
    maxSize: () => window.innerWidth - 320,
    persist: (size, collapsed) =>
      window.api.snowconfig.setLayout({ gitWidth: size, gitCollapsed: collapsed })
  })

  const activeTab = tabs.find((t) => t.id === activeId)
  const panelKey = activeTab?.id ?? -1
  const activeLinks = activeTab?.kind === 'shell' ? codeLinks[activeTab.id] : undefined
  const activeTurn = activeTab?.kind === 'shell' ? turns[activeTab.id] : undefined
  const activeSignature = activeLinks?.signature
  const panelView = panelViewFor(panelChoices[panelKey], activeLinks)
  const choosePanelView = useCallback(
    (view: PanelView): void =>
      setPanelChoices((prev) => ({ ...prev, [panelKey]: { view, signature: activeSignature } })),
    [panelKey, activeSignature]
  )
  const cwd =
    activeTab && (activeTab.kind === 'commit' || activeTab.kind === 'diff')
      ? activeTab.cwd
      : cwds[activeTab?.id ?? -1]
  const repoEntries = useMemo(
    () => repoEntriesOf(activeTab, cwd, cwds, panes),
    [activeTab, cwd, cwds, panes]
  )

  const activeEntries = frozen ? frozen.entries : repoEntries
  const discoverKey = activeEntries.map((entry) => entry.cwd).join('\n')
  const repos = useRepoDiscovery(discoverKey)

  const actionRepos = useMemo(
    () => actionReposOf(repos ?? [], activeEntries, presets),
    [repos, activeEntries, presets]
  )

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

  const repoPresetName = activeRepo?.presetName
  const repoPresetCwd = activeRepo?.presetCwd
  const commandPresets = useMemo(
    () =>
      commandPresetsOf(presets, activeEntries, {
        presetName: repoPresetName,
        presetCwd: repoPresetCwd
      }),
    [presets, activeEntries, repoPresetName, repoPresetCwd]
  )

  const commandItems = useMemo(
    () => commandItemsOf(presets, commandPresets),
    [presets, commandPresets]
  )

  const managePresetIndex = commandPresets[0] ?? -1

  const tabCwd = useCallback((tab: Tab): string | undefined => tabCwdOf(tab, cwds), [cwds])

  const agentSessions = useAgents()
  const [linkSource, setLinkSource] = useState<{
    sessions: AgentSession[]
    tabs: Tab[]
    panes: Record<number, Pane[]>
  } | null>(null)
  if (
    linkSource?.sessions !== agentSessions ||
    linkSource.tabs !== tabs ||
    linkSource.panes !== panes
  ) {
    setLinkSource({ sessions: agentSessions, tabs, panes })
    setCodeLinks((prev) => mergeCodeLinks(prev, agentSessions, tabs, panes))
    setTurns((prev) => mergeTurns(prev, agentSessions, tabs, panes))
  }
  const statusAgentSessions = useMemo(
    () => visibleAgentSessions(agentSessions, interruptedTerminals),
    [agentSessions, interruptedTerminals]
  )
  const workflowAgentSessions = useMemo<AgentSession[]>(
    () =>
      workflowSessionsOf(
        statusAgentSessions,
        shellTerminals(tabs, panes, terminalStatuses, titles, tabCwd)
      ),
    [statusAgentSessions, tabs, panes, terminalStatuses, titles, tabCwd]
  )

  const agentDirs = useMemo(() => agentDirsOf(statusAgentSessions, {}), [statusAgentSessions])
  const terminalAgents = useMemo(
    () => terminalAgentsOf(statusAgentSessions, {}),
    [statusAgentSessions]
  )

  const { sessionDirStatuses, sessionDirTitles, tabStatuses } = useMemo(
    () =>
      sessionStatusesOf({
        tabs,
        panes,
        terminalStatuses,
        titles,
        tabCwd,
        agentDirs,
        terminalAgents
      }),
    [tabs, tabCwd, panes, terminalStatuses, titles, agentDirs, terminalAgents]
  )

  const tabGroups = useTabGroups(tabs, tabCwd, repos)

  const groupsRef = useRef(tabGroups)
  useEffect(() => {
    groupsRef.current = tabGroups
  }, [tabGroups])

  const orderedTabs = useMemo(
    () => regroupTabs(tabs, (tab) => tabGroups[tab.id] ?? null),
    [tabs, tabGroups]
  )
  const orderedTabsRef = useRef(orderedTabs)
  useEffect(() => {
    orderedTabsRef.current = orderedTabs
  }, [orderedTabs])

  const sessionItems = useMemo(
    () =>
      orderedTabs.map((tab) => ({
        id: tab.id,
        group: tabGroups[tab.id] ?? null,
        preset:
          tab.kind === 'shell' && tab.presetName
            ? presets.find((preset) => preset.name === tab.presetName)
            : undefined
      })),
    [orderedTabs, presets, tabGroups]
  )

  const labels = useMemo(() => tabLabels(tabs, cwds, browserTitles), [tabs, cwds, browserTitles])

  const openSessions = useMemo(
    () => openSessionsOf(tabs, panes, tabCwd, labels, tabStatuses, titles),
    [tabs, panes, tabCwd, labels, tabStatuses, titles]
  )

  const addSession = useCallback(
    (preset?: Preset): void => {
      const id = nextIdRef.current++
      const cwd = preset?.cwd
      setTabs((prev) => [
        ...prev,
        {
          kind: 'shell',
          id,
          cwd,
          startupCommand: preset?.startupCommand,
          presetName: preset?.name,
          bottomTerminalId: nextTerminalId()
        }
      ])
      if (cwd) setCwds((prev) => ({ ...prev, [id]: cwd }))
      const splitPanes: Pane[] = (preset?.splits ?? [])
        .map((name) => presets.find((p) => p.name === name))
        .filter((p): p is Preset => p != null)
        .map((p) => ({
          id: nextTerminalId(),
          cwd: p.cwd,
          startupCommand: p.startupCommand ?? startupCommand ?? 'claude',
          presetName: p.name
        }))
      setPanes((prev) => ({ ...prev, [id]: [{ id: nextTerminalId() }, ...splitPanes] }))
      setActiveId(id)
    },
    [presets, startupCommand]
  )

  const addDefaultSession = useCallback(() => {
    addSession(presets.find((p) => p.default))
  }, [addSession, presets])

  const addSessionRef = useRef(addSession)
  useEffect(() => {
    addSessionRef.current = addSession
  })

  useEffect(() => {
    const open = (preset: Preset): void => {
      addSessionRef.current(presets.find((p) => p.name === preset.name) ?? preset)
    }
    if (presets.length > 0)
      window.api.cli.pending().then((preset) => {
        if (preset) open(preset)
      })
    return window.api.cli.onOpen(open)
  }, [presets])

  const openTab = useCallback((tab: Tab): void => {
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.id)
  }, [])

  const openCommit = useCallback(
    (cwd: string, hash: string): void => {
      const existing = tabsRef.current.find(
        (t) => t.kind === 'commit' && t.cwd === cwd && t.hash === hash
      )
      if (existing) {
        setActiveId(existing.id)
        return
      }
      openTab({ kind: 'commit', id: nextIdRef.current++, cwd, hash })
    },
    [openTab]
  )

  const openDiff = useCallback(
    (cwd: string, branch: string, file?: string): void => {
      const existing = tabsRef.current.find((t) => t.kind === 'diff' && !t.review && t.cwd === cwd)
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
      openTab({ kind: 'diff', id: nextIdRef.current++, cwd, branch, focus: file, focusKey: 0 })
    },
    [openTab]
  )

  const openReview = useCallback(
    (targets: WorkflowReviewTarget[]): void => {
      if (targets.length === 0) return
      const current = targets[0]
      const existing = tabsRef.current.find((tab) => tab.kind === 'diff' && tab.review)
      if (existing) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === existing.id && tab.kind === 'diff'
              ? {
                  ...tab,
                  cwd: current.cwd,
                  branch: current.branch,
                  focus: undefined,
                  focusKey: tab.focusKey + 1,
                  review: { targets, index: 0 }
                }
              : tab
          )
        )
        setActiveId(existing.id)
        return
      }
      openTab({
        kind: 'diff',
        id: nextIdRef.current++,
        cwd: current.cwd,
        branch: current.branch,
        focusKey: 0,
        review: { targets, index: 0 }
      })
    },
    [openTab]
  )

  const moveReview = useCallback((id: number, offset: -1 | 1): void => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== id || tab.kind !== 'diff' || !tab.review) return tab
        const index = Math.max(
          0,
          Math.min(tab.review.targets.length - 1, tab.review.index + offset)
        )
        if (index === tab.review.index) return tab
        const current = tab.review.targets[index]
        return {
          ...tab,
          cwd: current.cwd,
          branch: current.branch,
          focus: undefined,
          focusKey: tab.focusKey + 1,
          review: { ...tab.review, index }
        }
      })
    )
  }, [])

  const openBrowser = useCallback(
    (url = 'https://www.google.com'): void => {
      openTab({ kind: 'browser', id: nextIdRef.current++, url })
    },
    [openTab]
  )

  const openBlankBrowser = useCallback(() => {
    openBrowser()
  }, [openBrowser])

  const splitActive = useCallback(
    (preset?: Preset): void => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
      if (tab?.kind !== 'shell') return
      const paneId = nextTerminalId()
      const pane: Pane = preset
        ? {
            id: paneId,
            cwd: preset.cwd,
            startupCommand: preset.startupCommand ?? startupCommand ?? 'claude',
            presetName: preset.name
          }
        : { id: paneId }
      setPanes((prev) => ({ ...prev, [tab.id]: [...(prev[tab.id] ?? []), pane] }))
    },
    [startupCommand]
  )

  const splitActiveBlank = useCallback(() => {
    splitActive()
  }, [splitActive])

  const closeOverlay = useCallback((sessionId: number): void => {
    setOverlays((prev) => {
      if (!(sessionId in prev)) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [])

  const openSplit = (split: Split): void => {
    if (!activeTab || activeTab.kind !== 'shell') return
    setSplits((prev) => ({ ...prev, [activeTab.id]: split }))
    closeOverlay(activeTab.id)
  }

  const openCommitSplit = (cwd: string, hash: string): void => {
    openSplit({ kind: 'commit', cwd, hash })
  }

  const openDiffSplit = (cwd: string): void => {
    openSplit({ kind: 'diff', cwd })
  }

  const openBrowserSplit = (): void => {
    const id = nextIdRef.current++
    openSplit({ kind: 'browser', id, url: 'https://www.google.com' })
  }

  const hasBrowserSplit =
    activeTab?.kind === 'shell' &&
    splits[activeTab.id]?.kind === 'browser' &&
    !overlays[activeTab.id]

  const getSplitMenuPosition = useCallback(
    (button: DOMRect): { x: number; y: number } => {
      if (hasBrowserSplit) {
        const panel = gitPanelRef.current?.getBoundingClientRect()
        if (panel) return { x: panel.left, y: panel.top }
      }
      return { x: button.left, y: button.bottom + 4 }
    },
    [hasBrowserSplit]
  )

  const closeSplit = useCallback((sessionId: number): void => {
    setSplits((prev) => {
      if (!(sessionId in prev)) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [])

  const openCodeLink = useCallback((target: Omit<CodeLinkTarget, 'key'>): void => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab || tab.kind !== 'shell') return
    setOverlays((prev) => ({ ...prev, [tab.id]: { ...target, key: Date.now() } }))
  }, [])

  const openTurn = useCallback((): void => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current)
    if (!tab || tab.kind !== 'shell') return
    setOverlays((prev) => ({ ...prev, [tab.id]: { kind: 'turn', key: Date.now() } }))
  }, [])

  const closePane = useCallback((sessionId: number, paneId: number): void => {
    setPanes((prev) => {
      const current = prev[sessionId]
      if (!current || current.length <= 1) return prev
      return { ...prev, [sessionId]: current.filter((p) => p.id !== paneId) }
    })
  }, [])

  const handleSessionCwd = useCallback((sessionId: number, next: string): void => {
    setCwds((prev) => (prev[sessionId] === next ? prev : { ...prev, [sessionId]: next }))
  }, [])

  const handleSessionStatus = useCallback(
    (sessionId: number, nextTerminalStatuses: Record<number, SessionStatus>): void => {
      setTerminalStatuses((prev) => ({ ...prev, [sessionId]: nextTerminalStatuses }))
    },
    []
  )

  const handleSessionTitle = useCallback((sessionId: number, title: string): void => {
    setTitles((prev) => (prev[sessionId] === title ? prev : { ...prev, [sessionId]: title }))
  }, [])

  const handleSessionInterrupt = useCallback((_sessionId: number, terminalId: number): void => {
    setInterruptedTerminals((prev) => ({ ...prev, [terminalId]: Date.now() }))
  }, [])

  const handleBottomLayout = useCallback((height: number, collapsed: boolean): void => {
    window.api.snowconfig.setLayout({ bottomHeight: height, bottomCollapsed: collapsed })
  }, [])

  const handlePaneRatios = useCallback(
    (sessionId: number, ratios: number[]): void => {
      const tab = tabsRef.current.find((t) => t.id === sessionId)
      if (tab?.kind !== 'shell' || !tab.presetName) return
      const index = presetIndexFor(presets, { presetName: tab.presetName })
      const preset = presets[index]
      if (!preset || ratios.length !== 1 + (preset.splits?.length ?? 0)) return
      window.api.snowconfig.setPaneRatios(index, ratios)
    },
    [presets]
  )

  const addCommand = useCallback(
    (command: string): void => {
      window.api.snowconfig.addCommand(managePresetIndex, command)
    },
    [managePresetIndex]
  )

  const removeCommand = useCallback((item: CommandItem): void => {
    window.api.snowconfig.removeCommand(item.presetIndex, item.index)
  }, [])

  const showTour =
    !tourSeen && !tourDismissed && activeTab?.kind === 'shell' && repos != null && repos.length > 0

  const closeTour = (): void => {
    window.api.snowconfig.setTourSeen()
    setTourDismissed(true)
  }

  const closeSessions = useCallback((ids: number[]): void => {
    const idSet = new Set(ids)
    const current = orderedTabsRef.current
    const remaining = current.filter((t) => !idSet.has(t.id))
    const active = activeIdRef.current
    if (typeof active === 'number' && idSet.has(active)) {
      const index = current.findIndex((t) => t.id === active)
      const neighbor = remaining[index - 1] ?? remaining[index]
      setActiveId(neighbor ? neighbor.id : lastVisitedRef.current)
    }
    setTabs(remaining)
    const dropKeys = <T,>(prev: Record<number, T>): Record<number, T> => {
      const next = { ...prev }
      for (const id of ids) delete next[id]
      return next
    }
    setCwds(dropKeys)
    setPanes(dropKeys)
    setSplits(dropKeys)
    setOverlays(dropKeys)
    setCodeLinks(dropKeys)
    setTurns(dropKeys)
    setPanelChoices(dropKeys)
    setBrowserTitles(dropKeys)
    setTerminalStatuses(dropKeys)
    setTitles(dropKeys)
  }, [])

  const closeSession = useCallback((id: number): void => closeSessions([id]), [closeSessions])

  const openWorktree = useCallback(
    (worktree: string, repo?: string): void => {
      const existing = tabsRef.current.find(
        (tab) =>
          tab.kind === 'shell' &&
          (normalizePath(tab.cwd ?? cwdsRef.current[tab.id] ?? '') === normalizePath(worktree) ||
            normalizePath(cwdsRef.current[tab.id] ?? '') === normalizePath(worktree))
      )
      if (existing) {
        setActiveId(existing.id)
        return
      }

      const current = tabsRef.current.find((tab) => tab.id === activeIdRef.current)
      const parentCwd =
        current?.kind === 'shell' ? (current.cwd ?? cwdsRef.current[current.id]) : undefined
      const inherited = inheritedPreset(presets, repo, current, parentCwd)
      const id = nextIdRef.current++
      setTabs((prev) => [
        ...prev,
        {
          kind: 'shell',
          id,
          cwd: worktree,
          startupCommand: inherited?.startupCommand,
          presetName: inherited?.name,
          bottomTerminalId: nextTerminalId()
        }
      ])
      setCwds((prev) => ({ ...prev, [id]: worktree }))
      setPanes((prev) => ({ ...prev, [id]: [{ id: nextTerminalId() }] }))
      setActiveId(id)
    },
    [presets]
  )

  const closeWorktree = useCallback(
    (worktree: string): void => {
      const tab = tabsRef.current.find(
        (candidate) =>
          candidate.kind === 'shell' &&
          normalizePath(candidate.cwd ?? cwdsRef.current[candidate.id] ?? '') ===
            normalizePath(worktree)
      )
      if (tab) closeSession(tab.id)
    },
    [closeSession]
  )

  const openWorkflows = useCallback((): void => {
    setActiveId('workflows')
  }, [])

  const reorderTab = useCallback((from: number, to: number): void => {
    setTabs(
      (prev) =>
        moveTab(
          regroupTabs(prev, (tab) => groupsRef.current[tab.id] ?? null),
          from,
          to
        ) ?? prev
    )
  }, [])

  const reorderTabGroup = useCallback((from: number, count: number, to: number): void => {
    setTabs(
      (prev) =>
        moveTabGroup(
          regroupTabs(prev, (tab) => groupsRef.current[tab.id] ?? null),
          from,
          count,
          to
        ) ?? prev
    )
  }, [])

  const cycleTab = (delta: number): void => {
    const order: ActiveId[] = ['home', ...orderedTabs.map((t) => t.id)]
    const index = order.indexOf(activeId)
    if (index === -1) return
    setActiveId(order[(index + delta + order.length) % order.length])
  }

  useKeybinds(keybinds, {
    newTab: addDefaultSession,
    closeTab: typeof activeId === 'number' ? () => closeSession(activeId) : undefined,
    nextTab: tabs.length > 0 ? () => cycleTab(1) : undefined,
    prevTab: tabs.length > 0 ? () => cycleTab(-1) : undefined,
    newSplit: activeTab?.kind === 'shell' ? () => splitActive() : undefined,
    diffSplit:
      activeTab?.kind === 'shell' && actionCwd ? () => openDiffSplit(actionCwd) : undefined,
    runCommand: commandItems[0] ? () => toggleCommand(commandItems[0]) : undefined,
    switchRepo: actionRepos.length > 1 ? switchRepo : undefined,
    focusCommit: actionCwd
      ? () => document.querySelector<HTMLInputElement>('.actionbar-input')?.focus()
      : undefined,
    openWorkflows
  })

  usePresetDigitKeybind(
    keybinds,
    'splitPreset',
    activeId === 'home' || activeTab?.kind === 'shell'
      ? (index) => {
          const preset = visiblePresets[index]
          if (!preset) return
          if (activeId === 'home') addSession(preset)
          else splitActive(preset)
        }
      : undefined
  )

  usePresetDigitKeybind(keybinds, 'openPreset', (index) => {
    const preset = visiblePresets[index]
    if (preset) addSession(preset)
  })

  const mountedTabs = useMemo(() => [...tabs].sort((a, b) => a.id - b.id), [tabs])

  return (
    <div className="app">
      <PaneBoundary label="Action bar" className="pane-error-bar">
        <ActionBar
          cwd={actionCwd}
          repoName={activeRepo?.name}
          repoCount={actionRepos.length}
          onSwitchRepo={switchRepo}
          frozen={frozen !== null}
          onFreeze={(on) => setFrozen(on ? { entries: repoEntries } : null)}
          onOpenPullRequest={(url) => openBrowser(url)}
          onOpenWorktree={openWorktree}
          onCloseWorktree={closeWorktree}
          onManageWorkflows={openWorkflows}
          agentSessions={workflowAgentSessions}
          keybinds={keybinds}
        />
      </PaneBoundary>
      <div className="content">
        <div className="terminal-area">
          <TabBar
            sessions={sessionItems}
            activeId={activeId}
            labels={labels}
            statuses={tabStatuses}
            onSelect={setActiveId}
            onClose={closeSession}
            onCloseGroup={closeSessions}
            onAddGroup={addSession}
            onReorder={reorderTab}
            onReorderGroup={reorderTabGroup}
            onAdd={addDefaultSession}
            onOpenBrowser={openBlankBrowser}
            onOpenWorkflows={openWorkflows}
            onSplit={splitActiveBlank}
            presets={visiblePresets}
            onSplitWithPreset={splitActive}
            onSplitWithBrowser={openBrowserSplit}
            getSplitMenuPosition={getSplitMenuPosition}
            onToggleCommand={toggleCommand}
            onAddCommand={managePresetIndex >= 0 ? addCommand : undefined}
            onRemoveCommand={removeCommand}
            commands={commandItems}
            running={running}
            canSplit={activeTab?.kind === 'shell'}
          />
          <div className="terminal-stack">
            <PaneBoundary label="Home" active={activeId === 'home'}>
              <HomePage
                active={activeId === 'home'}
                presets={presets}
                name={configName}
                theme={themeName ?? 'theme'}
                error={presetsError}
                hooksPrompted={hooksPrompted}
                onOpenPreset={addSession}
              />
            </PaneBoundary>
            <PaneBoundary label="Workspaces" active={activeId === 'workflows'}>
              <WorkflowManager
                active={activeId === 'workflows'}
                onLaunch={openWorktree}
                onSelectSession={setActiveId}
                onCloseSession={closeSession}
                onOpenDiff={openDiff}
                onReviewAll={openReview}
                onCloseWorktree={closeWorktree}
                sessionStatuses={sessionDirStatuses}
                sessionTitles={sessionDirTitles}
                agentSessions={workflowAgentSessions}
                openSessions={openSessions}
                workspaceOrder={workspaceOrder}
                onWorkspaceOrderChange={setWorkspaceOrder}
              />
            </PaneBoundary>
            {mountedTabs.map((tab) => {
              const active = activeId === tab.id
              if (tab.kind === 'commit')
                return (
                  <PaneBoundary key={tab.id} label="Commit" active={active}>
                    <CommitView
                      active={active}
                      cwd={tab.cwd}
                      hash={tab.hash}
                      onOpenCommit={openCommit}
                    />
                  </PaneBoundary>
                )
              if (tab.kind === 'diff')
                return (
                  <PaneBoundary key={`${tab.id}:${tab.cwd}`} label="Diff" active={active}>
                    <WorkingDiffView
                      active={active}
                      cwd={tab.cwd}
                      focus={tab.focus}
                      focusKey={tab.focusKey}
                      review={
                        tab.review
                          ? {
                              index: tab.review.index,
                              total: tab.review.targets.length,
                              onPrevious: () => moveReview(tab.id, -1),
                              onNext: () => moveReview(tab.id, 1)
                            }
                          : undefined
                      }
                      onOpenCommit={openCommit}
                    />
                  </PaneBoundary>
                )
              if (tab.kind === 'browser')
                return (
                  <PaneBoundary key={tab.id} label="Browser" active={active}>
                    <BrowserTab
                      id={tab.id}
                      initialUrl={tab.url}
                      active={active}
                      onTitle={(title) =>
                        setBrowserTitles((prev) => ({ ...prev, [tab.id]: title }))
                      }
                    />
                  </PaneBoundary>
                )
              return (
                <PaneBoundary key={tab.id} label="Session" active={active}>
                  <Session
                    id={tab.id}
                    bottomTerminalId={tab.bottomTerminalId}
                    active={active}
                    cwd={tab.cwd}
                    panes={panes[tab.id] ?? []}
                    startupCommand={tab.startupCommand ?? startupCommand ?? 'claude'}
                    split={splits[tab.id]}
                    overlay={overlays[tab.id]}
                    turn={turns[tab.id]}
                    keybinds={keybinds}
                    savedBottomHeight={layout.bottomHeight}
                    savedBottomCollapsed={layout.bottomCollapsed}
                    savedPaneRatios={presets.find((p) => p.name === tab.presetName)?.paneRatios}
                    onBottomLayout={handleBottomLayout}
                    onPaneRatios={handlePaneRatios}
                    onCloseSplit={closeSplit}
                    onCloseOverlay={closeOverlay}
                    onOpenCommit={openCommit}
                    onClosePane={closePane}
                    onCwd={handleSessionCwd}
                    onStatus={handleSessionStatus}
                    onTitle={handleSessionTitle}
                    onInterrupt={handleSessionInterrupt}
                  />
                </PaneBoundary>
              )
            })}
          </div>
        </div>
        {!gitPane.collapsed && (
          <ResizeHandle
            axis="x"
            onStart={gitPane.onStart}
            onResize={gitPane.onResize}
            onEnd={gitPane.onEnd}
          />
        )}
        <PaneBoundary
          label="Git panel"
          active={!gitPane.collapsed}
          className="git-panel"
          style={{ flexBasis: gitPane.size }}
        >
          <GitPanel
            repos={repos}
            width={gitPane.size}
            collapsed={gitPane.collapsed}
            gradients={gradients}
            panelRef={gitPanelRef}
            onOpenCommit={openCommit}
            onOpenCommitSplit={activeTab?.kind === 'shell' ? openCommitSplit : undefined}
            onOpenDiff={openDiff}
            onOpenDiffSplit={activeTab?.kind === 'shell' ? openDiffSplit : undefined}
            links={activeLinks}
            turn={activeTurn}
            view={panelView}
            onViewChange={choosePanelView}
            onOpenLink={activeTab?.kind === 'shell' ? openCodeLink : undefined}
            onOpenTurn={activeTab?.kind === 'shell' ? openTurn : undefined}
          />
        </PaneBoundary>
        {gitPane.collapsed && (
          <PanelRestore
            className="panel-restore-git"
            label={'\u{f0797}'}
            title="Show git panel"
            onClick={gitPane.restore}
          />
        )}
      </div>
      {showTour && <Tour onClose={closeTour} />}
      {notice && <FailureDialog failure={notice} onDismiss={() => setNotice(null)} />}
    </div>
  )
}

export default App
