import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ActionBar from './components/ActionBar'
import CommitView from './components/CommitView'
import GitPanel, { type GitRepo } from './components/GitPanel'
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
import { basename, failureOf, isInside, normalizePath, shortHash, uniqueBy } from './format'
import type { Failure } from './format'
import { nextTerminalId } from './terminalId'
import { regroupTabs } from './tabGroups'
import { useKeybinds, usePresetDigitKeybind } from './keybinds'
import { useAgents, type AgentSession } from './useAgents'
import { useCollapsiblePane } from './useCollapsiblePane'
import { useSnowconfig, visiblePresetEntries, type Preset } from './useSnowconfig'
import type { ThemeInstallResult } from '../../main/themeInstall'
import type { HooksResult } from '../../main/hooks'
import {
  agentDirsOf,
  tabStatusFrom,
  terminalAgentsOf,
  visibleAgentSessions,
  workflowSessionsOf,
  type SessionStatus
} from './agentStatus'

export type { SessionStatus } from './agentStatus'

type ActiveId = number | 'home' | 'workflows'
type AppPage = Extract<ActiveId, string>

const GIT_MIN = 220
const GIT_COLLAPSE = 120

export type Split = { kind: 'commit'; cwd: string; hash: string } | { kind: 'diff'; cwd: string }

export type Pane = { id: number; cwd?: string; startupCommand?: string; presetName?: string }

type Tab =
  | {
      kind: 'shell'
      id: number
      cwd?: string
      startupCommand?: string
      presetName?: string
      bottomTerminalId: number
    }
  | { kind: 'commit'; id: number; cwd: string; hash: string }
  | { kind: 'diff'; id: number; cwd: string; branch: string; focus?: string; focusKey: number }
  | { kind: 'browser'; id: number; url: string }

type RepoEntry = { cwd: string; presetCwd?: string; presetName?: string }

export type CommandItem = {
  presetIndex: number
  presetName: string
  cwd: string
  command: string
  index: number
  runKey: string
}

function presetIndexFor(presets: Preset[], entry?: Partial<RepoEntry>): number {
  if (entry?.presetName != null) return presets.findIndex((p) => p.name === entry.presetName)
  if (entry?.presetCwd != null) return presets.findIndex((p) => p.cwd === entry.presetCwd)
  return -1
}

const byCwdLength =
  (dir: 1 | -1) =>
  (a: Preset, b: Preset): number =>
    dir * (normalizePath(a.cwd).length - normalizePath(b.cwd).length)

/**
 * The preset a worktree's tab should inherit its startup command from: the shortest-cwd preset
 * rooted in `repo` when a repo is given (launched from the workflow manager, root wins), otherwise
 * the active tab's own preset if it has one, falling back to the longest (most specific) preset
 * containing its parent cwd.
 */
function inheritedPreset(
  presets: Preset[],
  repo: string | undefined,
  current: Tab | undefined,
  parentCwd: string | undefined
): Preset | undefined {
  if (repo)
    return presets
      .filter((preset) => isInside(normalizePath(preset.cwd), normalizePath(repo)))
      .sort(byCwdLength(1))[0]
  if (current?.kind === 'shell' && current.presetName) {
    const named = presets.find((preset) => preset.name === current.presetName)
    if (named) return named
  }
  return presets
    .filter((preset) => parentCwd && isInside(normalizePath(parentCwd), normalizePath(preset.cwd)))
    .sort(byCwdLength(-1))[0]
}

function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<ActiveId>('home')
  const [cwds, setCwds] = useState<Record<number, string | undefined>>({})
  const [panes, setPanes] = useState<Record<number, Pane[]>>({})
  const [splits, setSplits] = useState<Record<number, Split>>({})
  const [running, setRunning] = useState<Record<string, number>>({})
  const [browserTitles, setBrowserTitles] = useState<Record<number, string>>({})
  const [terminalStatuses, setTerminalStatuses] = useState<
    Record<number, Record<number, SessionStatus>>
  >({})
  const [titles, setTitles] = useState<Record<number, string>>({})
  const [interruptedTerminals, setInterruptedTerminals] = useState<Record<number, number>>({})
  const [frozen, setFrozen] = useState<{ entries: RepoEntry[] } | null>(null)
  const [tourDismissed, setTourDismissed] = useState(false)
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
  const cwd =
    activeTab && (activeTab.kind === 'commit' || activeTab.kind === 'diff')
      ? activeTab.cwd
      : cwds[activeTab?.id ?? -1]
  const repoEntries = useMemo<RepoEntry[]>(() => {
    if (!activeTab) return cwd != null ? [{ cwd }] : []
    if (activeTab.kind === 'commit' || activeTab.kind === 'diff')
      return [{ cwd: activeTab.cwd, presetCwd: activeTab.cwd }]
    if (activeTab.kind === 'browser') return []
    const sessionPanes = panes[activeTab.id] ?? []
    const base = activeTab.cwd ?? cwds[activeTab.id]
    const pairs: RepoEntry[] = []
    if (base != null)
      pairs.push({ cwd: base, presetCwd: activeTab.cwd, presetName: activeTab.presetName })
    for (const pane of sessionPanes) {
      if (pane.cwd != null)
        pairs.push({ cwd: pane.cwd, presetCwd: pane.cwd, presetName: pane.presetName })
    }
    return uniqueBy(pairs, (entry) => entry.cwd)
  }, [activeTab, cwd, cwds, panes])

  const activeEntries = frozen ? frozen.entries : repoEntries
  const discoverKey = activeEntries.map((entry) => entry.cwd).join('\n')

  const [repos, setRepos] = useState<GitRepo[] | null>(null)
  useEffect(() => {
    let cancelled = false
    const cwds: (string | undefined)[] = discoverKey ? discoverKey.split('\n') : [undefined]
    const load = (): void => {
      Promise.all(cwds.map((cwd) => window.api.git.discover(cwd).catch(() => [])))
        .then((results) => {
          if (!cancelled) setRepos(uniqueBy(results.flat(), (repo) => repo.path))
        })
        .catch(() => {
          if (!cancelled) setRepos([])
        })
    }
    load()
    for (const cwd of cwds) window.api.git.watchRepos(cwd)
    const offRepos = window.api.git.onReposChanged(() => load())
    return () => {
      cancelled = true
      offRepos()
      for (const cwd of cwds) window.api.git.unwatchRepos(cwd)
    }
  }, [discoverKey])

  const actionRepos = useMemo(() => {
    return (repos ?? []).map((repo) => {
      const root = normalizePath(repo.path)
      const owner = activeEntries.find((entry) => isInside(normalizePath(entry.cwd), root))
      const adopted =
        presetIndexFor(presets, owner) >= 0
          ? undefined
          : presets.find((p) => isInside(normalizePath(p.cwd), root))
      return {
        cwd: repo.path,
        name: repo.name,
        presetCwd: owner?.presetCwd,
        presetName: owner?.presetName ?? adopted?.name
      }
    })
  }, [repos, activeEntries, presets])

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

  const repoPresetName = activeRepo?.presetName
  const repoPresetCwd = activeRepo?.presetCwd
  const commandPresets = useMemo(() => {
    const indices = activeEntries.map((entry) => presetIndexFor(presets, entry))
    indices.push(presetIndexFor(presets, { presetName: repoPresetName, presetCwd: repoPresetCwd }))
    return uniqueBy(
      indices.filter((index) => presets[index] != null),
      String
    )
  }, [presets, activeEntries, repoPresetName, repoPresetCwd])

  const commandItems = useMemo<CommandItem[]>(
    () =>
      commandPresets.flatMap((presetIndex) => {
        const preset = presets[presetIndex]
        return (preset.commands ?? []).map((command, index) => ({
          presetIndex,
          presetName: preset.name,
          cwd: preset.cwd,
          command,
          index,
          runKey: `${preset.name}\n${command}`
        }))
      }),
    [presets, commandPresets]
  )

  const managePresetIndex = commandPresets[0] ?? -1

  const tabCwd = useCallback(
    (tab: Tab): string | undefined => {
      if (tab.kind === 'shell') return cwds[tab.id] ?? tab.cwd
      if (tab.kind === 'commit' || tab.kind === 'diff') return tab.cwd
      return undefined
    },
    [cwds]
  )

  const agentSessions = useAgents()
  const statusAgentSessions = useMemo(
    () => visibleAgentSessions(agentSessions, interruptedTerminals),
    [agentSessions, interruptedTerminals]
  )
  const workflowAgentSessions = useMemo<AgentSession[]>(() => {
    const terminals = tabs.flatMap((tab) => {
      if (tab.kind !== 'shell') return []
      const sessionPanes = panes[tab.id] ?? []
      const sessionTerminals = terminalStatuses[tab.id] ?? {}
      return [
        ...sessionPanes.map((pane, index) => ({
          terminalId: pane.id,
          cwd: pane.cwd ?? tab.cwd,
          state: sessionTerminals[pane.id],
          detail: index === 0 ? titles[tab.id] : undefined
        })),
        {
          terminalId: tab.bottomTerminalId,
          cwd: tabCwd(tab),
          state: sessionTerminals[tab.bottomTerminalId]
        }
      ]
    })
    return workflowSessionsOf(statusAgentSessions, terminals)
  }, [statusAgentSessions, tabs, panes, terminalStatuses, titles, tabCwd])

  /**
   * Two agents in one directory are one row on screen, so the loudest state wins rather than the
   * newest: an agent waiting on a permission prompt is the thing worth surfacing even while its
   * neighbour keeps working.
   */
  const agentDirs = useMemo(() => {
    return agentDirsOf(statusAgentSessions, {})
  }, [statusAgentSessions])
  const terminalAgents = useMemo(
    () => terminalAgentsOf(statusAgentSessions, {}),
    [statusAgentSessions]
  )

  /**
   * A hook-reported state always beats the PTY byte heuristic, which stays as the floor for panes
   * no agent reports - a bottom shell, an `npm run dev` split, a session with no hooks installed.
   * A directory with no tab is folded in only while its agent is working or waiting: an `idle`
   * record there is as likely to be a session killed without a SessionEnd as a live one, and
   * nothing on screen distinguishes the two.
   *
   * Tab dots are session-specific: only hook records bound to one of the tab's terminals can
   * override its own byte heuristic. Directory identity is a separate workflow-manager rollup, so
   * two tabs opened in the same folder retain independent dots while both contribute to that
   * folder's aggregate activity.
   */
  const { sessionDirStatuses, sessionDirTitles, tabStatuses } = useMemo(() => {
    const sessionDirStatuses: Record<string, SessionStatus> = {}
    const sessionDirTitles: Record<string, string> = {}
    const tabStatuses: Record<number, SessionStatus> = {}
    const rank: Record<SessionStatus, number> = { attention: 2, busy: 1, idle: 0 }
    const addDirectoryStatus = (
      dir: string | undefined,
      status: SessionStatus | undefined,
      title?: string
    ): void => {
      if (!dir || !status) return
      const key = normalizePath(dir)
      const current = sessionDirStatuses[key]
      if (!current || rank[status] > rank[current]) sessionDirStatuses[key] = status
      if (title && !sessionDirTitles[key]) sessionDirTitles[key] = title
    }

    for (const tab of tabs) {
      if (tab.kind !== 'shell') continue
      const dir = tabCwd(tab)
      const sessionPanes = panes[tab.id] ?? []
      const sessionTerminals = terminalStatuses[tab.id] ?? {}
      const status = tabStatusFrom(
        terminalAgents,
        [tab.bottomTerminalId, ...sessionPanes.map((pane) => pane.id)],
        sessionTerminals
      )
      if (status) tabStatuses[tab.id] = status

      for (const [index, pane] of sessionPanes.entries()) {
        addDirectoryStatus(
          pane.cwd ?? tab.cwd,
          sessionTerminals[pane.id],
          index === 0 ? titles[tab.id] : undefined
        )
      }
      addDirectoryStatus(dir, sessionTerminals[tab.bottomTerminalId])
    }
    for (const [dir, agent] of Object.entries(agentDirs)) {
      // An idle record is useful only where a visible terminal already establishes a live session.
      if (agent.state === 'idle' && !(dir in sessionDirStatuses)) continue
      // Hook state is authoritative for its directory; the byte heuristic is only its fallback.
      sessionDirStatuses[dir] = agent.state
      if (agent.detail && !sessionDirTitles[dir]) sessionDirTitles[dir] = agent.detail
    }
    return { sessionDirStatuses, sessionDirTitles, tabStatuses }
  }, [tabs, tabCwd, panes, terminalStatuses, titles, agentDirs, terminalAgents])

  const [roots, setRoots] = useState<Record<string, string | null>>({})
  const [rootsEpoch, setRootsEpoch] = useState(0)
  const rootsRef = useRef(roots)
  useEffect(() => {
    rootsRef.current = roots
  }, [roots])
  const rootsKey = useMemo(
    () =>
      uniqueBy(
        tabs.map(tabCwd).filter((dir): dir is string => dir != null),
        (dir) => dir
      ).join('\n'),
    [tabs, tabCwd]
  )

  useEffect(
    () =>
      window.api.git.onReposChanged(() => {
        setRoots({})
        setRootsEpoch((epoch) => epoch + 1)
      }),
    []
  )

  useEffect(() => {
    let cancelled = false
    const dirs = (rootsKey ? rootsKey.split('\n') : []).filter((dir) => !(dir in rootsRef.current))
    if (dirs.length === 0) return
    Promise.all(
      dirs.map(async (dir) => {
        const owner = (repos ?? []).find((repo) =>
          isInside(normalizePath(dir), normalizePath(repo.path))
        )
        const root = owner ? owner.common : await window.api.git.mainRoot(dir)
        return [dir, root] as const
      })
    ).then((resolved) => {
      if (!cancelled) setRoots((prev) => ({ ...prev, ...Object.fromEntries(resolved) }))
    })
    return () => {
      cancelled = true
    }
  }, [rootsKey, rootsEpoch, repos])

  const tabGroups = useMemo(() => {
    const result: Record<number, string | null> = {}
    for (const tab of tabs) {
      const dir = tabCwd(tab)
      const root = dir ? roots[dir] : null
      const presetName = tab.kind === 'shell' ? tab.presetName : undefined
      result[tab.id] = root || (presetName ? `preset:${presetName}` : null)
    }
    return result
  }, [tabs, tabCwd, roots])

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

  const openSessions = useMemo(
    () =>
      tabs.flatMap((tab) => {
        if (tab.kind !== 'shell') return []
        const sessionPanes = panes[tab.id] ?? []
        return [
          {
            id: tab.id,
            dir: tabCwd(tab),
            label: labels[tab.id] ?? `Session ${tab.id}`,
            status: tabStatuses[tab.id],
            title: titles[tab.id],
            terminalIds: [tab.bottomTerminalId, ...sessionPanes.map((pane) => pane.id)]
          }
        ]
      }),
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

  const [notice, setNotice] = useState<Failure | null>(null)

  useEffect(() => {
    const installed = (result: ThemeInstallResult): void => {
      if (result.error) setNotice(failureOf({ error: result.error, detail: result.detail }))
    }
    void window.api.theme.pendingInstall().then((result) => {
      if (result) installed(result)
    })
    return window.api.theme.onInstalled(installed)
  }, [])

  useEffect(() => {
    const ran = (result: HooksResult): void => {
      setNotice(
        result.error
          ? failureOf({ error: result.error, detail: result.detail })
          : { title: result.message, detail: result.detail }
      )
    }
    void window.api.hooks.pending().then((result) => {
      if (result) ran(result)
    })
    return window.api.hooks.onChanged(ran)
  }, [])

  const openCommit = useCallback((cwd: string, hash: string): void => {
    const existing = tabsRef.current.find(
      (t) => t.kind === 'commit' && t.cwd === cwd && t.hash === hash
    )
    if (existing) {
      setActiveId(existing.id)
      return
    }
    const id = nextIdRef.current++
    setTabs((prev) => [...prev, { kind: 'commit', id, cwd, hash }])
    setActiveId(id)
  }, [])

  const openDiff = useCallback((cwd: string, branch: string, file?: string): void => {
    const existing = tabsRef.current.find((t) => t.kind === 'diff' && t.cwd === cwd)
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
  }, [])

  const openBrowser = useCallback((url = 'https://www.google.com'): void => {
    const id = nextIdRef.current++
    setTabs((prev) => [...prev, { kind: 'browser', id, url }])
    setActiveId(id)
  }, [])

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

  const closeSplit = useCallback((sessionId: number): void => {
    setSplits((prev) => {
      if (!(sessionId in prev)) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
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

  const toggleCommand = useCallback(
    (item: CommandItem): void => {
      const existing = running[item.runKey]
      if (existing != null) {
        window.api.terminal.kill(existing)
        setRunning((prev) => {
          const next = { ...prev }
          delete next[item.runKey]
          return next
        })
        return
      }
      const id = nextTerminalId()
      window.api.terminal.spawn(id, 80, 24, item.cwd, `${item.command}; exit`)
      setRunning((prev) => ({ ...prev, [item.runKey]: id }))
    },
    [running]
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
    setTabs((prev) => {
      const ordered = regroupTabs(prev, (tab) => groupsRef.current[tab.id] ?? null)
      const target = to > from ? to - 1 : to
      if (from < 0 || from >= ordered.length || target < 0 || target >= ordered.length) return prev
      if (target === from) return prev
      const next = [...ordered]
      next.splice(target, 0, next.splice(from, 1)[0])
      return next
    })
  }, [])

  const reorderTabGroup = useCallback((from: number, count: number, to: number): void => {
    setTabs((prev) => {
      const ordered = regroupTabs(prev, (tab) => groupsRef.current[tab.id] ?? null)
      if (
        from < 0 ||
        count < 1 ||
        from + count > ordered.length ||
        to < 0 ||
        to > ordered.length ||
        (to >= from && to <= from + count)
      ) {
        return prev
      }
      const next = [...ordered]
      const moved = next.splice(from, count)
      const target = to > from ? to - count : to
      next.splice(target, 0, ...moved)
      return next
    })
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
            onToggleCommand={toggleCommand}
            onAddCommand={managePresetIndex >= 0 ? addCommand : undefined}
            onRemoveCommand={removeCommand}
            commands={commandItems}
            running={running}
            canSplit={activeTab?.kind === 'shell'}
          />
          <div className="terminal-stack">
            <HomePage
              active={activeId === 'home'}
              presets={presets}
              name={configName}
              theme={themeName ?? 'theme'}
              error={presetsError}
              hooksPrompted={hooksPrompted}
              onOpenPreset={addSession}
            />
            <WorkflowManager
              active={activeId === 'workflows'}
              onLaunch={openWorktree}
              onSelectSession={setActiveId}
              onCloseSession={closeSession}
              onOpenDiff={openDiff}
              onCloseWorktree={closeWorktree}
              sessionStatuses={sessionDirStatuses}
              sessionTitles={sessionDirTitles}
              agentSessions={workflowAgentSessions}
              openSessions={openSessions}
              workspaceOrder={workspaceOrder}
              onWorkspaceOrderChange={setWorkspaceOrder}
            />
            {mountedTabs.map((tab) => {
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
                  id={tab.id}
                  bottomTerminalId={tab.bottomTerminalId}
                  active={activeId === tab.id}
                  cwd={tab.cwd}
                  panes={panes[tab.id] ?? []}
                  startupCommand={tab.startupCommand ?? startupCommand ?? 'claude'}
                  split={splits[tab.id]}
                  keybinds={keybinds}
                  savedBottomHeight={layout.bottomHeight}
                  savedBottomCollapsed={layout.bottomCollapsed}
                  savedPaneRatios={presets.find((p) => p.name === tab.presetName)?.paneRatios}
                  onBottomLayout={handleBottomLayout}
                  onPaneRatios={handlePaneRatios}
                  onCloseSplit={closeSplit}
                  onOpenCommit={openCommit}
                  onClosePane={closePane}
                  onCwd={handleSessionCwd}
                  onStatus={handleSessionStatus}
                  onTitle={handleSessionTitle}
                  onInterrupt={handleSessionInterrupt}
                />
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
        <GitPanel
          repos={repos}
          width={gitPane.size}
          collapsed={gitPane.collapsed}
          gradients={gradients}
          onOpenCommit={openCommit}
          onOpenCommitSplit={activeTab?.kind === 'shell' ? openCommitSplit : undefined}
          onOpenDiff={openDiff}
          onOpenDiffSplit={activeTab?.kind === 'shell' ? openDiffSplit : undefined}
        />
        {gitPane.collapsed && (
          <PanelRestore
            className="panel-restore-git"
            label="󰞗"
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
