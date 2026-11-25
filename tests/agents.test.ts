import { describe, expect, it } from 'vitest'
import { parseLinks } from '../src/main/agents'

describe('parseLinks', () => {
  it('keeps valid items and drops malformed ones', () => {
    expect(
      parseLinks({
        root: '/repo',
        at: 1,
        items: [
          { path: 'a.ts', line: 3 },
          { path: 'a.ts', line: 3 },
          { path: 'b.ts', line: 2, endLine: 4 },
          { path: 'c.ts', line: 5, endLine: 5 },
          { path: 'd.ts', line: -1, endLine: 9 },
          { path: '' },
          { line: 4 },
          null
        ]
      })
    ).toEqual({
      root: '/repo',
      at: 1,
      items: [
        { path: 'a.ts', line: 3 },
        { path: 'b.ts', line: 2, endLine: 4 },
        { path: 'c.ts', line: 5 },
        { path: 'd.ts' }
      ]
    })
  })

  it('rejects a missing root, a missing timestamp or an empty list', () => {
    expect(parseLinks({ at: 1, items: [{ path: 'a.ts' }] })).toBeUndefined()
    expect(parseLinks({ root: '/repo', items: [{ path: 'a.ts' }] })).toBeUndefined()
    expect(parseLinks({ root: '/repo', at: 1, items: [] })).toBeUndefined()
    expect(parseLinks('nope')).toBeUndefined()
  })

  it('rejects a relative root and paths escaping it', () => {
    expect(parseLinks({ root: 'relative/dir', at: 1, items: [{ path: 'a.ts' }] })).toBeUndefined()
    expect(
      parseLinks({
        root: '/repo',
        at: 7,
        items: [
          { path: '../x.ts' },
          { path: 'src/../../y.ts' },
          { path: '/etc/passwd' },
          { path: 'C:\\x.ts' },
          { path: 'C:Windows/win.ini' },
          { path: '..env.local' }
        ]
      })
    ).toEqual({ root: '/repo', at: 7, items: [{ path: '..env.local' }] })
  })
})
