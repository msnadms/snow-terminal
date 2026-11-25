import { describe, expect, it } from 'vitest'
import { parseDiff } from 'react-diff-view'
import {
  fileIndexFor,
  linkLabel,
  rangeOf,
  selectedKeysFor,
  sourceWindow
} from '@renderer/codeLinks'

const patch = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,4 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '-four',
  '+FOUR',
  ''
].join('\n')

const [file] = parseDiff(patch)

describe('selectedKeysFor', () => {
  it('selects new-side lines in range', () => {
    expect(selectedKeysFor(file.hunks, { start: 2, end: 3 })).toEqual(['I2', 'N3'])
  })

  it('returns nothing for a line outside every hunk', () => {
    expect(selectedKeysFor(file.hunks, { start: 40, end: 40 })).toEqual([])
  })
})

describe('link helpers', () => {
  it('formats and ranges links', () => {
    expect(linkLabel({ path: 'a.ts' })).toBe('a.ts')
    expect(linkLabel({ path: 'a.ts', line: 3 })).toBe('a.ts:3')
    expect(linkLabel({ path: 'a.ts', line: 3, endLine: 5 })).toBe('a.ts:3-5')
    expect(rangeOf({ path: 'a.ts', line: 3, endLine: 5 })).toEqual({ start: 3, end: 5 })
    expect(rangeOf({ path: 'a.ts' })).toBeUndefined()
  })
})

describe('sourceWindow', () => {
  it('shows a short file whole', () => {
    expect(sourceWindow(10, { start: 3, end: 4 })).toEqual({ start: 1, end: 10 })
  })

  it('centres a long file on the cited range and clamps at both ends', () => {
    expect(sourceWindow(10000, { start: 5000, end: 5000 })).toEqual({ start: 4000, end: 5999 })
    expect(sourceWindow(10000)).toEqual({ start: 1, end: 2000 })
    expect(sourceWindow(10000, { start: 9990, end: 12000 })).toEqual({ start: 8001, end: 10000 })
  })
})

describe('fileIndexFor', () => {
  it('prefers an exact path over a rename source', () => {
    const files = [
      { path: 'b.ts', oldPath: 'a.ts' },
      { path: 'a.ts', oldPath: null }
    ]
    expect(fileIndexFor(files, 'a.ts')).toBe(1)
    expect(fileIndexFor(files, 'b.ts')).toBe(0)
    expect(fileIndexFor(files.slice(0, 1), 'a.ts')).toBe(0)
    expect(fileIndexFor(files, 'c.ts')).toBe(-1)
  })
})
