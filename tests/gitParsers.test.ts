import { describe, expect, it } from 'vitest'
import { cleanCommitMessage, truncateDiffForPrompt } from '../src/main/commitMessage'
import { parseWorktreeList } from '../src/main/gitCore'
import { capPatch, layout, parseBlame, parseNumstat } from '../src/main/gitHistory'
import { parseConflictedNames } from '../src/main/mergeCheck'
import { collidingUntracked, newestStash, parseStashList } from '../src/main/park'

describe('parseNumstat', () => {
  it('reads plain, binary and renamed entries', () => {
    const raw = [
      '3\t1\tsrc/a.ts',
      '-\t-\timage.png',
      '2\t0\t',
      'old/name.ts',
      'new/name.ts',
      ''
    ].join('\0')
    expect(parseNumstat(raw)).toEqual([
      { path: 'src/a.ts', oldPath: null, additions: 3, deletions: 1, binary: false },
      { path: 'image.png', oldPath: null, additions: 0, deletions: 0, binary: true },
      { path: 'new/name.ts', oldPath: 'old/name.ts', additions: 2, deletions: 0, binary: false }
    ])
  })
})

describe('capPatch', () => {
  it('leaves a short patch alone', () => {
    expect(capPatch('diff --git a b\n+x\n', 100)).toEqual({
      patch: 'diff --git a b\n+x\n',
      truncated: false
    })
  })

  it('cuts at the last whole file', () => {
    const patch = 'diff --git a/1 b/1\n+one\ndiff --git a/2 b/2\n+two two two two\n'
    expect(capPatch(patch, 40)).toEqual({ patch: 'diff --git a/1 b/1\n+one\n', truncated: true })
  })
})

describe('parseBlame', () => {
  it('maps final line numbers to commits and recovers the source', () => {
    const hash = 'a'.repeat(40)
    const raw = [
      `${hash} 1 1 2`,
      'author Ada',
      'author-time 0',
      '\tfirst',
      `${hash} 2 2`,
      'author Ada',
      'author-time 1700000000',
      '\tsecond'
    ].join('\n')
    const result = parseBlame(raw)
    expect(result.source).toBe('first\nsecond')
    expect(result.lines[1]).toEqual({ hash, author: 'Ada', date: '' })
    expect(result.lines[2].date).toBe(new Date(1700000000 * 1000).toISOString())
  })
})

describe('layout', () => {
  const commit = (hash: string, parents: string[]): Parameters<typeof layout>[0][number] => ({
    hash,
    parents,
    author: '',
    date: '',
    subject: hash,
    refs: ''
  })

  it('keeps a linear history in one lane', () => {
    const { commits, laneCount } = layout([commit('c', ['b']), commit('b', ['a']), commit('a', [])])
    expect(commits.map((c) => c.col)).toEqual([0, 0, 0])
    expect(laneCount).toBe(1)
  })

  it('opens a second lane for a merged branch', () => {
    const { commits, laneCount } = layout([
      commit('m', ['a', 'f']),
      commit('f', ['base']),
      commit('a', ['base']),
      commit('base', [])
    ])
    expect(commits.find((c) => c.hash === 'f')?.col).toBe(1)
    expect(commits.find((c) => c.hash === 'base')?.col).toBe(0)
    expect(laneCount).toBe(2)
  })
})

describe('parseWorktreeList', () => {
  it('maps branches to directories and skips detached and prunable entries', () => {
    const raw = [
      'worktree /repo',
      'HEAD 1111',
      'branch refs/heads/main',
      '',
      'worktree /repo-worktrees/feat',
      'HEAD 2222',
      'branch refs/heads/feat/x',
      '',
      'worktree /tmp/detached',
      'HEAD 3333',
      'detached',
      '',
      'worktree /gone',
      'HEAD 4444',
      'branch refs/heads/gone',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n')
    expect([...parseWorktreeList(raw)]).toEqual([
      ['main', '/repo'],
      ['feat/x', '/repo-worktrees/feat']
    ])
  })
})

describe('parseConflictedNames', () => {
  it('stops at the empty separator before informational messages', () => {
    const stdout = [
      'treeoid',
      'a.txt',
      'b.txt',
      'a.txt',
      '',
      'Auto-merging a.txt',
      'CONFLICT'
    ].join('\0')
    expect(parseConflictedNames(stdout)).toEqual(['a.txt', 'b.txt'])
  })

  it('reads every name when no separator is present', () => {
    expect(parseConflictedNames('treeoid\0x')).toEqual(['x'])
  })
})

describe('parseStashList', () => {
  it('keeps only snow markers, newest first', () => {
    const raw = [
      'stash@{0}\x1fOn feat: snow-wf:feat\x1f2026-01-02',
      'stash@{1}\x1fWIP on main: 123 manual\x1f2026-01-01',
      'stash@{2}\x1fsnow-wf:feat\x1f2025-12-31',
      'stash@{3}\x1fOn x: snow-wf:other/branch\x1f'
    ].join('\n')
    const entries = parseStashList(raw)
    expect(entries.map((e) => [e.selector, e.branch])).toEqual([
      ['stash@{0}', 'feat'],
      ['stash@{2}', 'feat'],
      ['stash@{3}', 'other/branch']
    ])
    expect(newestStash(entries, 'feat')?.selector).toBe('stash@{0}')
    expect(newestStash(entries, 'missing')).toBeNull()
  })
})

describe('collidingUntracked', () => {
  it('extracts files git refused to overwrite', () => {
    const error = new Error(
      'error: could not restore untracked files\nnotes.txt already exists, no checkout\n  dir/x already exists, no checkout'
    )
    expect(collidingUntracked(error)).toEqual(['notes.txt', 'dir/x'])
  })
})

describe('commit message helpers', () => {
  it('strips fences and collapses double spaces', () => {
    expect(cleanCommitMessage('```\nAdd  thing\n\nBody  text.\n```\n')).toBe(
      'Add thing\n\nBody text.'
    )
    expect(cleanCommitMessage('  Plain subject  ')).toBe('Plain subject')
  })

  it('truncates a diff at a file boundary', () => {
    const diff = 'diff --git a/1 b/1\n+1\ndiff --git a/2 b/2\n+22222222222\n'
    expect(truncateDiffForPrompt(diff, 40)).toBe('diff --git a/1 b/1\n+1\n\n[diff truncated]')
    expect(truncateDiffForPrompt(diff)).toBe(diff)
  })
})
