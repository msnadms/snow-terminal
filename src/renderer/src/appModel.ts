import type { GitRepo } from './components/GitPanel'
import { basename, isInside, normalizePath, shortHash, uniqueBy } from './format'
import type { Preset } from './useSnowconfig'
import type { AgentSession } from './useAgents'
import type { OpenSession, WorkflowReviewTarget } from './workflowRows'
import { statusRank, tabStatusFrom, type AgentDir, type SessionStatus } from './agentStatus'

export type { SessionStatus } from './agentStatus'

export type ActiveId = number | 'home' | 'workflows'
export type AppPage = Extract<ActiveId, string>

export type Split =
  | { kind: 'commit'; cwd: string; hash: string }
  | { kind: 'diff'; cwd: string }
  | { kind: 'browser'; id: number; url: string }

export type Pane = { id: number; cwd?: string; startupCommand?: string; presetName?: string }

export type ShellTab = {
  kind: 'shell'
  id: number
  cwd?: string
  startupCommand?: string
  presetName?: string
  bottomTerminalId: number
}

export type Tab =
  | ShellTab
  | { kind: 'commit'; id: number; cwd: string; hash: string }
  | {
      kind: 'diff'
      id: number
      cwd: string
      branch: string
      focus?: string
      focusKey: number
      review?: { targets: WorkflowReviewTarget[]; index: number }
    }
  | { kind: 'browser'; id: number; url: string }

export type RepoEntry = { cwd: string; presetCwd?: string; presetName?: string }

export type ActionRepo = { cwd: string; name: string; presetCwd?: string; presetName?: string }

export type CommandItem = {
  presetIndex: number
  presetName: string
  cwd: string
  command: string
  index: number
  runKey: string
}

export type TerminalStatuses = Record<number, Record<number, SessionStatus>>

export function presetIndexFor(presets: Preset[], entry?: Partial<RepoEntry>): number {
  if (entry?.presetName != null) return presets.findIndex((p) => p.name === entry.presetName)
  if (entry?.presetCwd != null) return presets.findIndex((p) => p.cwd === entry.presetCwd)
  return -1
}

const byCwdLength =
  (dir: 1 | -1) =>
  (a: Preset, b: Preset): number =>
    dir * (normalizePath(a.cwd).length - normalizePath(b.cwd).length)

export function inheritedPreset(
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

export function tabCwdOf(tab: Tab, cwds: Record<number, string | undefined>): string | undefined {
  if (tab.kind === 'shell') return cwds[tab.id] ?? tab.cwd
  if (tab.kind === 'commit' || tab.kind === 'diff') return tab.cwd
  return undefined
}

export function repoEntriesOf(
  activeTab: Tab | undefined,
  cwd: string | undefined,
  cwds: Record<number, string | undefined>,
  panes: Record<number, Pane[]>
): RepoEntry[] {
  if (!activeTab) return cwd != null ? [{ cwd }] : []
  if (activeTab.kind === 'commit' || activeTab.kind === 'diff')
    return [{ cwd: activeTab.cwd, presetCwd: activeTab.cwd }]
  if (activeTab.kind === 'browser') return []
  const base = activeTab.cwd ?? cwds[activeTab.id]
  const pairs: RepoEntry[] = []
  if (base != null)
    pairs.push({ cwd: base, presetCwd: activeTab.cwd, presetName: activeTab.presetName })
  for (const pane of panes[activeTab.id] ?? []) {
    if (pane.cwd != null)
      pairs.push({ cwd: pane.cwd, presetCwd: pane.cwd, presetName: pane.presetName })
  }
  return uniqueBy(pairs, (entry) => entry.cwd)
}

export function actionReposOf(
  repos: GitRepo[],
  entries: RepoEntry[],
  presets: Preset[]
): ActionRepo[] {
  return repos.map((repo) => {
    const root = normalizePath(repo.path)
    const owner = entries.find((entry) => isInside(normalizePath(entry.cwd), root))
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
}

export function commandPresetsOf(
  presets: Preset[],
  entries: RepoEntry[],
  adopted: Partial<RepoEntry>
): number[] {
  const indices = entries.map((entry) => presetIndexFor(presets, entry))
  indices.push(presetIndexFor(presets, adopted))
  return uniqueBy(
    indices.filter((index) => presets[index] != null),
    String
  )
}

export function commandItemsOf(presets: Preset[], presetIndices: number[]): CommandItem[] {
  return presetIndices.flatMap((presetIndex) => {
    const preset = presets[presetIndex]
    return (preset.commands ?? []).map((command, index) => ({
      presetIndex,
      presetName: preset.name,
      cwd: preset.cwd,
      command,
      index,
      runKey: `${preset.name}\n${command}`
    }))
  })
}

export function tabLabels(
  tabs: Tab[],
  cwds: Record<number, string | undefined>,
  browserTitles: Record<number, string>
): Record<number, string> {
  const result: Record<number, string> = {}
  for (const tab of tabs) {
    if (tab.kind === 'commit') {
      result[tab.id] = shortHash(tab.hash)
    } else if (tab.kind === 'diff') {
      result[tab.id] = tab.review
        ? `Review ${tab.review.index + 1}/${tab.review.targets.length}`
        : `${tab.branch} ✎`
    } else if (tab.kind === 'browser') {
      result[tab.id] = browserTitles[tab.id] ?? 'Browser'
    } else {
      const dir = cwds[tab.id]
      if (dir) result[tab.id] = basename(dir)
    }
  }
  return result
}

export function shellTerminals(
  tabs: Tab[],
  panes: Record<number, Pane[]>,
  terminalStatuses: TerminalStatuses,
  titles: Record<number, string>,
  tabCwd: (tab: Tab) => string | undefined
): { terminalId: number; cwd?: string; state?: SessionStatus; detail?: string }[] {
  return tabs.flatMap((tab) => {
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
}

interface StatusInput {
  tabs: Tab[]
  panes: Record<number, Pane[]>
  terminalStatuses: TerminalStatuses
  titles: Record<number, string>
  tabCwd: (tab: Tab) => string | undefined
  agentDirs: Record<string, AgentDir>
  terminalAgents: ReadonlyMap<number, AgentDir>
}

export interface SessionStatuses {
  sessionDirStatuses: Record<string, SessionStatus>
  sessionDirTitles: Record<string, string>
  tabStatuses: Record<number, SessionStatus>
}

export function sessionStatusesOf({
  tabs,
  panes,
  terminalStatuses,
  titles,
  tabCwd,
  agentDirs,
  terminalAgents
}: StatusInput): SessionStatuses {
  const sessionDirStatuses: Record<string, SessionStatus> = {}
  const sessionDirTitles: Record<string, string> = {}
  const tabStatuses: Record<number, SessionStatus> = {}
  const addDirectoryStatus = (
    dir: string | undefined,
    status: SessionStatus | undefined,
    title?: string
  ): void => {
    if (!dir || !status) return
    const key = normalizePath(dir)
    const current = sessionDirStatuses[key]
    if (!current || statusRank[status] > statusRank[current]) sessionDirStatuses[key] = status
    if (title && !sessionDirTitles[key]) sessionDirTitles[key] = title
  }

  for (const tab of tabs) {
    if (tab.kind !== 'shell') continue
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
    addDirectoryStatus(tabCwd(tab), sessionTerminals[tab.bottomTerminalId])
  }
  for (const [dir, agent] of Object.entries(agentDirs)) {
    if (agent.state === 'idle' && !(dir in sessionDirStatuses)) continue
    sessionDirStatuses[dir] = agent.state
    if (agent.detail && !sessionDirTitles[dir]) sessionDirTitles[dir] = agent.detail
  }
  return { sessionDirStatuses, sessionDirTitles, tabStatuses }
}

export function openSessionsOf(
  tabs: Tab[],
  panes: Record<number, Pane[]>,
  tabCwd: (tab: Tab) => string | undefined,
  labels: Record<number, string>,
  tabStatuses: Record<number, SessionStatus>,
  titles: Record<number, string>
): OpenSession[] {
  return tabs.flatMap((tab) => {
    if (tab.kind !== 'shell') return []
    const sessionPanes = panes[tab.id] ?? []
    const directories = [tabCwd(tab), ...sessionPanes.map((pane) => pane.cwd ?? tab.cwd)].filter(
      (dir): dir is string => !!dir
    )
    return [
      {
        id: tab.id,
        dir: tabCwd(tab),
        directories,
        label: labels[tab.id] ?? `Session ${tab.id}`,
        status: tabStatuses[tab.id],
        title: titles[tab.id],
        terminalIds: [tab.bottomTerminalId, ...sessionPanes.map((pane) => pane.id)]
      }
    ]
  })
}

export function moveTab<T>(ordered: T[], from: number, to: number): T[] | null {
  const target = to > from ? to - 1 : to
  if (from < 0 || from >= ordered.length || target < 0 || target >= ordered.length) return null
  if (target === from) return null
  const next = [...ordered]
  next.splice(target, 0, next.splice(from, 1)[0])
  return next
}

export function moveTabGroup<T>(ordered: T[], from: number, count: number, to: number): T[] | null {
  if (
    from < 0 ||
    count < 1 ||
    from + count > ordered.length ||
    to < 0 ||
    to > ordered.length ||
    (to >= from && to <= from + count)
  ) {
    return null
  }
  const next = [...ordered]
  const moved = next.splice(from, count)
  const target = to > from ? to - count : to
  next.splice(target, 0, ...moved)
  return next
}

export type CodeLinks = NonNullable<AgentSession['links']>
export type CodeLink = CodeLinks['items'][number]
export type TabCodeLinks = Omit<CodeLinks, 'at'> & { updated: number; signature: string }
export type CodeLinkTarget = CodeLink & { root: string; key: number }
export type PanelView = 'git' | 'links'
export type PanelChoice = { view: PanelView; signature?: string }

export function panelViewFor(choice: PanelChoice | undefined, links?: TabCodeLinks): PanelView {
  if (links && choice?.signature !== links.signature) return 'links'
  return choice?.view ?? 'git'
}

export function tabForTerminal(
  tabs: Tab[],
  panes: Record<number, Pane[]>,
  terminalId: number
): number | null {
  const tab = tabs.find(
    (candidate) =>
      candidate.kind === 'shell' &&
      (candidate.bottomTerminalId === terminalId ||
        (panes[candidate.id] ?? []).some((pane) => pane.id === terminalId))
  )
  return tab ? tab.id : null
}

export function mergeCodeLinks(
  previous: Record<number, TabCodeLinks>,
  sessions: AgentSession[],
  tabs: Tab[],
  panes: Record<number, Pane[]>
): Record<number, TabCodeLinks> {
  let next = previous
  const ordered = [...sessions].sort((a, b) => (a.links?.at ?? 0) - (b.links?.at ?? 0))
  for (const session of ordered) {
    if (!session.links || session.terminalId === undefined) continue
    const tabId = tabForTerminal(tabs, panes, session.terminalId)
    if (tabId === null) continue
    const { root, items } = session.links
    const signature = JSON.stringify({ root, items })
    const updated = session.links.at
    const current = next[tabId]
    if (current && (current.signature === signature || current.updated > updated)) continue
    next = { ...next, [tabId]: { root, items, updated, signature } }
  }
  return next
}
