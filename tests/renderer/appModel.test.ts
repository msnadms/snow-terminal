import { describe, expect, it } from 'vitest'
import {
  commandItemsOf,
  commandPresetsOf,
  inheritedPreset,
  moveTab,
  moveTabGroup,
  presetIndexFor,
  repoEntriesOf,
  tabLabels,
  type Tab
} from '@renderer/appModel'
import type { Preset } from '@renderer/useSnowconfig'

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
