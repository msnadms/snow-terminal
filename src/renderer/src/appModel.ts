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
  | { kind: 'file'; id: number; cwd: string; path: string; treeCwd?: string }
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
  if (tab.kind === 'commit' || tab.kind === 'diff' || tab.kind === 'file') return tab.cwd
  return undefined
}

export function repoEntriesOf(
  activeTab: Tab | undefined,
  cwd: string | undefined,
  cwds: Record<number, string | undefined>,
  panes: Record<number, Pane[]>
): RepoEntry[] {
  if (!activeTab) return cwd != null ? [{ cwd }] : []
  if (activeTab.kind === 'commit' || activeTab.kind === 'diff' || activeTab.kind === 'file')
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
    } else if (tab.kind === 'file') {
      result[tab.id] = basename(tab.path)
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
export type AgentTurn = NonNullable<AgentSession['turn']>
export type TabTurn = AgentTurn & { sessionId: string; live: boolean }
export type Overlay = CodeLinkTarget | { kind: 'turn'; key: number }
export const panelViews = ['git', 'files', 'links'] as const
export type PanelView = (typeof panelViews)[number]
export type PanelSignals = Partial<Record<PanelView, string>>
export type PanelChoice = { view: PanelView; seen: PanelSignals }

export function panelViewFor(choice: PanelChoice | undefined): PanelView {
  return choice?.view ?? panelViews[0]
}

export function unseenPanelViews(
  choice: PanelChoice | undefined,
  signals: PanelSignals
): PanelView[] {
  const showing = panelViewFor(choice)
  return panelViews.filter(
    (view) =>
      view !== showing && signals[view] !== undefined && signals[view] !== choice?.seen[view]
  )
}

export function choosePanel(
  choice: PanelChoice | undefined,
  view: PanelView,
  signals: PanelSignals
): PanelChoice {
  const showing = panelViewFor(choice)
  return {
    view,
    seen: { ...choice?.seen, [showing]: signals[showing], [view]: signals[view] }
  }
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

export function mergeTurns(
  previous: Record<number, TabTurn>,
  sessions: AgentSession[],
  tabs: Tab[],
  panes: Record<number, Pane[]>
): Record<number, TabTurn> {
  let next = previous
  const set = (tabId: number, turn: TabTurn | null): void => {
    const rest = { ...next }
    if (turn) rest[tabId] = turn
    else delete rest[tabId]
    next = rest
  }
  for (const session of sessions) {
    if (session.terminalId === undefined) continue
    const tabId = tabForTerminal(tabs, panes, session.terminalId)
    if (tabId === null) continue
    const current = next[tabId]
    const turn = session.turn
    if (!turn) {
      if (current?.sessionId === session.sessionId && session.updated >= current.at)
        set(tabId, null)
      continue
    }
    const live = !turn.end && session.state !== 'idle'
    const same = current?.at === turn.at && current.base === turn.base
    if (current && current.at > turn.at) continue
    if (same && turn.end === current.end && live === current.live) continue
    if (same && !turn.end && current.end) continue
    set(tabId, { ...turn, sessionId: session.sessionId, live })
  }
  const reporting = new Set(sessions.map((session) => session.sessionId))
  for (const [key, turn] of Object.entries(next)) {
    if (turn.live && !reporting.has(turn.sessionId)) set(Number(key), { ...turn, live: false })
  }
  return next
}

export function treeRoot(cwd: string): string {
  const normalized = normalizePath(cwd)
  if (normalized === '') return '/'
  return /^[A-Za-z]:$/.test(normalized) ? `${normalized}/` : normalized
}

export function childPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

function isBelow(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

export function fileTarget(
  repo: { root: string; prefix: string } | null,
  name: string
): { root: string; path: string } | null {
  return repo ? { root: repo.root, path: `${repo.prefix}${name}` } : null
}

export function collapseDir(expanded: ReadonlySet<string>, dir: string): Set<string> {
  return new Set([...expanded].filter((path) => path !== dir && !isBelow(path, dir)))
}

export function changedDirs(
  expanded: ReadonlySet<string>,
  dir: string,
  names: string[] | null
): string[] {
  const roots = names ? names.map((name) => childPath(dir, name)) : [dir]
  return [
    dir,
    ...[...expanded].filter((path) => roots.some((root) => path === root || isBelow(path, root)))
  ].filter((path, index, all) => all.indexOf(path) === index)
}

export type SearchHit = {
  path: string
  dir: boolean
  target: { root: string; path: string } | null
}

export interface SearchNode {
  name: string
  path: string
  dir: boolean
  match: boolean
  target: { root: string; path: string } | null
  children: SearchNode[]
}

function sortNodes(nodes: SearchNode[]): SearchNode[] {
  return nodes
    .sort(
      (a, b) =>
        Number(b.dir) - Number(a.dir) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    )
    .map((node) => ({ ...node, children: sortNodes(node.children) }))
}

export function searchTree(hits: SearchHit[]): SearchNode[] {
  const top: SearchNode[] = []
  const nodes = new Map<string, SearchNode>()
  const nodeAt = (path: string, name: string, siblings: SearchNode[]): SearchNode => {
    const existing = nodes.get(path)
    if (existing) return existing
    const node: SearchNode = { name, path, dir: true, match: false, target: null, children: [] }
    nodes.set(path, node)
    siblings.push(node)
    return node
  }
  for (const hit of hits) {
    const segments = hit.path.split('/')
    let siblings = top
    let path = ''
    segments.forEach((name, i) => {
      path = path ? `${path}/${name}` : name
      const node = nodeAt(path, name, siblings)
      if (i === segments.length - 1)
        Object.assign(node, { dir: hit.dir, match: true, target: hit.target })
      siblings = node.children
    })
  }
  return sortNodes(top)
}

export function foldCase(text: string): string {
  let folded = ''
  for (const char of text) folded += char.toLowerCase()
  return folded
}

export function matchParts(name: string, query: string): { text: string; match: boolean }[] {
  const needle = foldCase(query.trim())
  if (!needle) return [{ text: name, match: false }]
  let haystack = ''
  const starts: number[] = []
  const ends: number[] = []
  for (let i = 0; i < name.length;) {
    const char = String.fromCodePoint(name.codePointAt(i)!)
    const lower = char.toLowerCase()
    for (let k = 0; k < lower.length; k++) {
      starts.push(i)
      ends.push(i + char.length)
    }
    haystack += lower
    i += char.length
  }
  const parts: { text: string; match: boolean }[] = []
  let from = 0
  let scan = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, scan)) {
    const start = Math.max(starts[at], from)
    const end = ends[at + needle.length - 1]
    if (start > from) parts.push({ text: name.slice(from, start), match: false })
    if (end > start) parts.push({ text: name.slice(start, end), match: true })
    from = Math.max(from, end)
    scan = at + needle.length
  }
  if (from < name.length) parts.push({ text: name.slice(from), match: false })
  return parts
}
