import { describe, expect, it } from 'vitest'
import {
  identityOf,
  isWithin,
  parseIgnored,
  parseRepoLocation,
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
