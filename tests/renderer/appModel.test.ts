import { describe, expect, it } from 'vitest'
import {
  commandItemsOf,
  commandPresetsOf,
  inheritedPreset,
  mergeCodeLinks,
  mergeTurns,
  panelViewFor,
  moveTab,
  moveTabGroup,
  presetIndexFor,
  repoEntriesOf,
  tabForTerminal,
  tabLabels,
  type Tab
} from '@renderer/appModel'
import type { Preset } from '@renderer/useSnowconfig'
import type { AgentSession } from '@renderer/useAgents'

const presets = [
  { name: 'snow', cwd: '/src/snow', commands: ['npm run dev'] },
  { name: 'api', cwd: '/src/snow/api', commands: ['make', 'make test'] },
  { name: 'other', cwd: '/src/other' }
] as Preset[]

describe('presetIndexFor', () => {
  it('prefers the captured name over the cwd', () => {
    expect(presetIndexFor(presets, { presetName: 'api', presetCwd: '/src/snow' })).toBe(1)
    expect(presetIndexFor(presets, { presetCwd: '/src/other' })).toBe(2)
    expect(presetIndexFor(presets, {})).toBe(-1)
  })
})

describe('command items', () => {
  it('unions session presets with the adopted one, deduplicated', () => {
    const indices = commandPresetsOf(
      presets,
      [{ cwd: '/src/snow', presetName: 'snow' }, { cwd: '/x' }],
      { presetName: 'api' }
    )
    expect(indices).toEqual([0, 1])
    expect(commandItemsOf(presets, indices).map((item) => [item.presetIndex, item.index])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1]
    ])
    expect(commandItemsOf(presets, [1])[1].runKey).toBe('api\nmake test')
  })
})

describe('inheritedPreset', () => {
  it('takes the shortest preset inside a launched repo', () => {
    expect(inheritedPreset(presets, '/src/snow', undefined, undefined)?.name).toBe('snow')
  })

  it('falls back to the most specific preset containing the parent cwd', () => {
    expect(inheritedPreset(presets, undefined, undefined, '/src/snow/api/lib')?.name).toBe('api')
  })
})

describe('repoEntriesOf', () => {
  it('lists the base cwd and each split pane once', () => {
    const tab: Tab = {
      kind: 'shell',
      id: 1,
      cwd: '/src/snow',
      presetName: 'snow',
      bottomTerminalId: 9
    }
    const entries = repoEntriesOf(
      tab,
      undefined,
      { 1: '/src/snow' },
      {
        1: [
          { id: 2 },
          { id: 3, cwd: '/src/other', presetName: 'other' },
          { id: 4, cwd: '/src/snow' }
        ]
      }
    )
    expect(entries).toEqual([
      { cwd: '/src/snow', presetCwd: '/src/snow', presetName: 'snow' },
      { cwd: '/src/other', presetCwd: '/src/other', presetName: 'other' }
    ])
  })
})

describe('tabLabels', () => {
  it('labels each tab kind', () => {
    const tabs: Tab[] = [
      { kind: 'commit', id: 1, cwd: '/r', hash: 'abcdef1234567890' },
      { kind: 'diff', id: 2, cwd: '/r', branch: 'feat', focusKey: 0 },
      {
        kind: 'diff',
        id: 3,
        cwd: '/r',
        branch: 'x',
        focusKey: 0,
        review: {
          targets: [
            { cwd: '/a', branch: 'a' },
            { cwd: '/b', branch: 'b' }
          ],
          index: 1
        }
      },
      { kind: 'browser', id: 4, url: 'https://example.com' },
      { kind: 'shell', id: 5, bottomTerminalId: 6 }
    ]
    const labels = tabLabels(tabs, { 5: '/src/snow' }, {})
    expect(labels[2]).toBe('feat ✎')
    expect(labels[3]).toBe('Review 2/2')
    expect(labels[4]).toBe('Browser')
    expect(labels[5]).toBe('snow')
    expect(labels[1]).toMatch(/^abcdef1/)
  })
})

describe('tab moves', () => {
  it('moves one tab to an insertion slot', () => {
    expect(moveTab(['a', 'b', 'c'], 0, 3)).toEqual(['b', 'c', 'a'])
    expect(moveTab(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveTab(['a', 'b', 'c'], 1, 1)).toBeNull()
    expect(moveTab(['a', 'b', 'c'], 1, 2)).toBeNull()
    expect(moveTab(['a'], 3, 0)).toBeNull()
  })

  it('moves a contiguous group', () => {
    expect(moveTabGroup(['a', 'b', 'c', 'd'], 0, 2, 4)).toEqual(['c', 'd', 'a', 'b'])
    expect(moveTabGroup(['a', 'b', 'c', 'd'], 2, 2, 0)).toEqual(['c', 'd', 'a', 'b'])
    expect(moveTabGroup(['a', 'b', 'c', 'd'], 0, 2, 1)).toBeNull()
    expect(moveTabGroup(['a', 'b', 'c', 'd'], 0, 0, 3)).toBeNull()
  })
})

describe('code links', () => {
  const tabs: Tab[] = [
    { kind: 'shell', id: 1, bottomTerminalId: 10 },
    { kind: 'shell', id: 2, bottomTerminalId: 20 }
  ]
  const panes = { 1: [{ id: 11 }], 2: [{ id: 21 }, { id: 22 }] }
  const session = (terminalId: number, updated: number, path: string): AgentSession => ({
    sessionId: `s${terminalId}`,
    terminalId,
    cwd: '/repo',
    state: 'idle',
    detail: '',
    agent: 'claude',
    updated,
    links: { root: '/repo', at: updated, items: [{ path, line: 1 }] }
  })

  it('maps a terminal to the tab that owns it', () => {
    expect(tabForTerminal(tabs, panes, 22)).toBe(2)
    expect(tabForTerminal(tabs, panes, 10)).toBe(1)
    expect(tabForTerminal(tabs, panes, 99)).toBeNull()
  })

  it('keeps the newest set per tab and ignores unchanged links', () => {
    const first = mergeCodeLinks({}, [session(11, 5, 'a.ts'), session(22, 6, 'b.ts')], tabs, panes)
    expect(first[1].items[0].path).toBe('a.ts')
    expect(first[2].items[0].path).toBe('b.ts')

    expect(mergeCodeLinks(first, [session(11, 9, 'a.ts')], tabs, panes)).toBe(first)
    const replaced = mergeCodeLinks(first, [session(21, 9, 'c.ts')], tabs, panes)
    expect(replaced[2]).toMatchObject({ updated: 9, items: [{ path: 'c.ts', line: 1 }] })
    expect(mergeCodeLinks(replaced, [session(22, 6, 'b.ts')], tabs, panes)).toBe(replaced)
  })

  it('orders by when the links were extracted, not by the latest status write', () => {
    const stale = {
      ...session(21, 300, 'old.ts'),
      links: { root: '/repo', at: 100, items: [{ path: 'old.ts' }] }
    }
    const fresh = {
      ...session(22, 250, 'new.ts'),
      links: { root: '/repo', at: 250, items: [{ path: 'new.ts' }] }
    }
    const merged = mergeCodeLinks({}, [stale, fresh], tabs, panes)
    expect(merged[2]).toMatchObject({ updated: 250, items: [{ path: 'new.ts' }] })
    const rewritten = { ...stale, updated: 400 }
    expect(mergeCodeLinks(merged, [rewritten], tabs, panes)).toBe(merged)
  })
})

describe('turns', () => {
  const tabs: Tab[] = [{ kind: 'shell', id: 1, bottomTerminalId: 10 }]
  const panes = { 1: [{ id: 11 }, { id: 12 }] }
  const session = (terminalId: number, at: number, end?: string): AgentSession => ({
    sessionId: `s${terminalId}`,
    terminalId,
    cwd: '/repo',
    state: 'idle',
    detail: '',
    agent: 'claude',
    updated: at,
    turn: { root: '/repo', base: `base${at}`, at, ...(end ? { end } : {}) }
  })

  it('keeps the newest turn per tab and picks up its end', () => {
    const first = mergeTurns({}, [session(11, 5)], tabs, panes)
    expect(first[1]).toMatchObject({ base: 'base5' })
    expect(mergeTurns(first, [session(11, 5)], tabs, panes)).toBe(first)
    const ended = mergeTurns(first, [session(11, 5, 'end5')], tabs, panes)
    expect(ended[1].end).toBe('end5')
    expect(mergeTurns(ended, [session(11, 5)], tabs, panes)).toBe(ended)
    expect(mergeTurns(ended, [session(12, 3, 'old')], tabs, panes)).toBe(ended)
    expect(mergeTurns(ended, [session(12, 8)], tabs, panes)[1]).toMatchObject({ base: 'base8' })
  })

  it('tracks whether an unended turn is still running', () => {
    const busy = { ...session(11, 5), state: 'busy' as const }
    const running = mergeTurns({}, [busy], tabs, panes)
    expect(running[1]).toMatchObject({ sessionId: 's11', live: true })
    expect(mergeTurns(running, [session(11, 5)], tabs, panes)[1].live).toBe(false)
    expect(mergeTurns(running, [], tabs, panes)[1].live).toBe(false)
  })

  it('drops the held turn once its session moves to a prompt with no turn', () => {
    const first = session(11, 5)
    const tracked = mergeTurns(
      {},
      [{ ...first, promptId: 'p1', turn: { ...first.turn!, promptId: 'p1' } }],
      tabs,
      panes
    )
    const moved = { ...first, promptId: 'p2', turn: undefined }
    expect(mergeTurns(tracked, [moved], tabs, panes)[1]).toBeUndefined()
    expect(mergeTurns(tracked, [{ ...moved, sessionId: 'other' }], tabs, panes)[1]).toBeDefined()
    expect(mergeTurns(tracked, [{ ...moved, updated: 4 }], tabs, panes)[1]).toBeDefined()
  })

  it('drops the held turn for a session that reports no prompt ids', () => {
    const tracked = mergeTurns({}, [session(11, 5)], tabs, panes)
    const failed = { ...session(11, 5), updated: 9, turn: undefined }
    expect(mergeTurns(tracked, [failed], tabs, panes)[1]).toBeUndefined()
  })
})

describe('panelViewFor', () => {
  it('raises a view whose signal changed, then honours the choice', () => {
    expect(panelViewFor(undefined, {})).toBe('git')
    expect(panelViewFor(undefined, { links: 'a' })).toBe('links')
    expect(panelViewFor({ view: 'git', seen: { links: 'a' } }, { links: 'a' })).toBe('git')
    expect(panelViewFor({ view: 'git', seen: { links: 'a' } }, { links: 'b' })).toBe('links')
    expect(panelViewFor({ view: 'links', seen: {} }, {})).toBe('links')
  })

  it('ignores a signal that disappeared since the choice', () => {
    expect(panelViewFor({ view: 'git', seen: { links: 'a' } }, {})).toBe('git')
  })
})
