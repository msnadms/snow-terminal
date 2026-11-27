import { describe, expect, it } from 'vitest'
import {
  identityOf,
  isWithin,
  parseIgnored,
  parseLsFiles,
  parseRepoLocation,
  searchFiles,
  sortEntries
} from '../src/main/files'

describe('sortEntries', () => {
  it('puts directories first, then orders names case-insensitively and numerically', () => {
    const entries = [
      { name: 'b.ts', dir: false, ignored: false },
      { name: 'src', dir: true, ignored: false },
      { name: 'A.ts', dir: false, ignored: false },
      { name: 'file10.ts', dir: false, ignored: false },
      { name: 'file2.ts', dir: false, ignored: false },
      { name: 'Assets', dir: true, ignored: false }
    ]
    expect(sortEntries(entries).map((entry) => entry.name)).toEqual([
      'Assets',
      'src',
      'A.ts',
      'b.ts',
      'file2.ts',
      'file10.ts'
    ])
  })
})

describe('parseIgnored', () => {
  it('reads NUL-separated names', () => {
    expect(parseIgnored('node_modules\0out\0')).toEqual(new Set(['node_modules', 'out']))
    expect(parseIgnored('')).toEqual(new Set())
  })
})

describe('isWithin', () => {
  it('matches the directory itself and anything below it, not siblings sharing a prefix', () => {
    expect(isWithin('/work/app', '/work/app')).toBe(true)
    expect(isWithin('/work/app/src/deep', '/work/app')).toBe(true)
    expect(isWithin('/work/application', '/work/app')).toBe(false)
    expect(isWithin('/work', '/work/app')).toBe(false)
  })

  it('treats a child whose name starts with two dots as inside', () => {
    expect(isWithin('/work/app/..cache', '/work/app')).toBe(true)
    expect(isWithin('/work/app/..cache/deep', '/work/app')).toBe(true)
    expect(isWithin('/work/..app', '/work/app')).toBe(false)
  })
})

describe('identityOf', () => {
  it('tells apart a recreated directory that reused the inode', () => {
    expect(identityOf({ ino: 42, birthtimeMs: 1000 })).not.toBe(
      identityOf({ ino: 42, birthtimeMs: 2000 })
    )
    expect(identityOf({ ino: 42, birthtimeMs: 1000 })).toBe(
      identityOf({ ino: 42, birthtimeMs: 1000 })
    )
  })
})

describe('parseRepoLocation', () => {
  it('reads the top level and the prefix of the listed directory', () => {
    expect(parseRepoLocation('C:/work/app\nsrc/deep/\n')).toEqual({
      root: 'C:/work/app',
      prefix: 'src/deep/'
    })
    expect(parseRepoLocation('/work/app\n\n')).toEqual({ root: '/work/app', prefix: '' })
    expect(parseRepoLocation('')).toBeNull()
  })
})

describe('parseLsFiles', () => {
  it('maps files to repo targets and reports nested repositories', () => {
    const parsed = parseLsFiles(
      `100644 ${'a'.repeat(40)} 0\ta.ts\0`,
      'lib/b.ts\0nested/\0',
      'sub/',
      { root: '/r', prefix: 'x/' }
    )
    expect(parsed.files).toEqual([
      { path: 'sub/a.ts', target: { root: '/r', path: 'x/a.ts' } },
      { path: 'sub/lib/b.ts', target: { root: '/r', path: 'x/lib/b.ts' } }
    ])
    expect(parsed.nested).toEqual(['nested'])
  })

  it('descends into submodules instead of listing them as files', () => {
    const parsed = parseLsFiles(`160000 ${'b'.repeat(40)} 0\tvendor/lib\0`, '', '', {
      root: '/r',
      prefix: ''
    })
    expect(parsed.files).toEqual([])
    expect(parsed.nested).toEqual(['vendor/lib'])
  })

  it('lists a conflicted path once across its stages', () => {
    const stages = [1, 2, 3].map((n) => `100644 ${'c'.repeat(40)} ${n}\tapp.ts\0`).join('')
    expect(parseLsFiles(stages, '', '', { root: '/r', prefix: '' }).files).toHaveLength(1)
  })
})

describe('searchFiles', () => {
  const files = [
    { path: 'src/main/files.ts', target: null },
    { path: 'src/renderer/FileTree.tsx', target: null },
    { path: 'tests/files.test.ts', target: null },
    { path: 'README.md', target: null }
  ]

  it('matches file and folder names case-insensitively, each folder once', () => {
    expect(searchFiles(files, 'FILE', 10).hits.map((hit) => hit.path)).toEqual([
      'src/main/files.ts',
      'src/renderer/FileTree.tsx',
      'tests/files.test.ts'
    ])
    expect(searchFiles(files, 'src', 10).hits).toEqual([{ path: 'src', dir: true, target: null }])
  })

  it('caps hits but counts every match', () => {
    expect(searchFiles(files, 'file', 1)).toMatchObject({
      total: 3,
      hits: [{ path: 'src/main/files.ts' }]
    })
  })

  it('matches nothing for a blank query', () => {
    expect(searchFiles(files, '  ', 10).total).toBe(0)
  })
})
