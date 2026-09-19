import path from 'path'
import { describe, expect, it } from 'vitest'
import { addProvenance, overlapReport, workingClaims } from '../src/main/overlaps'
import type { WorkflowOverlap } from '../src/main/workflowTypes'
import { nameStatusPaths, worktreeContainer, worktreeDirectory } from '../src/main/worktrees'

describe('worktreeDirectory', () => {
  const repo = path.resolve('/src/snow')

  it('places worktrees in a sibling container', () => {
    expect(worktreeContainer(repo)).toBe(path.resolve('/src/snow-worktrees'))
    expect(worktreeDirectory(repo, 'feature')).toBe(path.join(worktreeContainer(repo), 'feature'))
  })

  it('suffixes a digest only when sanitizing changed the name', () => {
    const slashed = path.basename(worktreeDirectory(repo, 'feature/login'))
    const dashed = path.basename(worktreeDirectory(repo, 'feature-login'))
    expect(dashed).toBe('feature-login')
    expect(slashed).toMatch(/^feature-login-[0-9a-f]{7}$/)
    expect(slashed).not.toBe(dashed)
  })

  it('falls back when nothing path-safe remains', () => {
    expect(path.basename(worktreeDirectory(repo, '///'))).toMatch(/^workflow-[0-9a-f]{7}$/)
  })
})

describe('nameStatusPaths', () => {
  it('reads both sides of renames and copies', () => {
    const raw = [
      'M',
      'a.txt',
      'R100',
      'old.txt',
      'new.txt',
      'C75',
      'src.txt',
      'copy.txt',
      'D',
      'gone.txt',
      ''
    ].join('\0')
    expect(nameStatusPaths(raw)).toEqual([
      'a.txt',
      'old.txt',
      'new.txt',
      'src.txt',
      'copy.txt',
      'gone.txt'
    ])
  })
})

describe('workingClaims', () => {
  it('claims both sides of a rename', () => {
    const claims = workingClaims({
      files: [
        { path: 'new.txt', from: 'old.txt', index: 'R', working_dir: ' ' },
        { path: 'a.txt', index: ' ', working_dir: 'M' }
      ]
    })
    expect(claims).toEqual([
      { path: 'old.txt', source: 'working' },
      { path: 'new.txt', source: 'working' },
      { path: 'a.txt', source: 'working' }
    ])
  })
})

describe('addProvenance', () => {
  it('keeps committed and dirty provenance separately', () => {
    const committed = addProvenance(undefined, 'committed')
    expect(committed).toEqual({ committed: true, dirty: null })
    const parked = addProvenance(committed, 'parked')
    expect(parked).toEqual({ committed: true, dirty: 'parked' })
    expect(addProvenance(parked, 'working')).toEqual({ committed: true, dirty: 'working' })
    expect(addProvenance(addProvenance(undefined, 'working'), 'parked')).toEqual({
      committed: false,
      dirty: 'working'
    })
  })
})

describe('overlapReport', () => {
  const row = (file: string, verdict: WorkflowOverlap['verdict']): WorkflowOverlap => ({
    path: file,
    verdict,
    source: 'committed',
    branches: []
  })

  it('sorts conflicts first and counts every verdict before capping', () => {
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => row(`clean-${String(i).padStart(2, '0')}`, 'clean')),
      ...Array.from({ length: 10 }, (_, i) => row(`overlap-${i}`, 'overlap')),
      row('b', 'conflict'),
      row('a', 'conflict')
    ]
    const report = overlapReport(rows)
    expect(report.overlapTotals).toEqual({ conflict: 2, overlap: 10, clean: 15 })
    expect(report.overlaps).toHaveLength(20)
    expect(report.overlaps.slice(0, 3).map((o) => o.path)).toEqual(['a', 'b', 'overlap-0'])
    expect(report.overlaps.at(-1)?.verdict).toBe('clean')
  })
})
