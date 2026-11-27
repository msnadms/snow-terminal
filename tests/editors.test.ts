import path from 'path'
import { describe, expect, it } from 'vitest'
import { parseVswhere, vscodeUrl } from '../src/main/editors'
import { strictlyInside } from '../src/main/gitCore'

describe('vscodeUrl', () => {
  it.each([
    ['C:\\Users\\me\\repo\\src\\a.ts', 12, 'vscode://file/C:/Users/me/repo/src/a.ts:12:1'],
    ['C:\\Users\\my name\\a.ts', undefined, 'vscode://file/C:/Users/my%20name/a.ts'],
    ['/home/me/repo/#odd?.ts', 3, 'vscode://file/home/me/repo/%23odd%3F.ts:3:1'],
    ['/repo/logs/run:12.txt', undefined, 'vscode://file/repo/logs/run%3A12.txt'],
    ['/c:/a.ts', 2, 'vscode://file/c:/a.ts:2:1']
  ])('%s', (file, line, expected) => {
    expect(vscodeUrl(file, line)).toBe(expected)
  })
})

describe('strictlyInside', () => {
  const fsRoot = path.resolve('/')
  const repo = path.resolve('/repo')

  it.each([
    ['a file under a filesystem-root repo', fsRoot, path.join(fsRoot, 'a.ts'), true],
    ['a nested file', repo, path.join(repo, 'src', 'a.ts'), true],
    ['a name starting with dots', repo, path.join(repo, '..notes'), true],
    ['the root itself', repo, repo, false],
    ['the parent', repo, path.dirname(repo), false],
    ['a sibling sharing a prefix', repo, path.resolve('/repo-other/a.ts'), false],
    ['an escape through ..', repo, path.resolve(repo, '../b.ts'), false]
  ])('%s', (_name, root, full, expected) => {
    expect(strictlyInside(root, full)).toBe(expected)
  })
})

describe('parseVswhere', () => {
  it('reads the latest install and its DTE ProgID', () => {
    const stdout = JSON.stringify([
      {
        installationVersion: '17.8.34525.116',
        productPath: 'C:\\VS\\Common7\\IDE\\devenv.exe'
      }
    ])
    expect(parseVswhere(stdout)).toEqual({
      devenv: 'C:\\VS\\Common7\\IDE\\devenv.exe',
      progId: 'VisualStudio.DTE.17.0'
    })
  })

  it.each([
    ['[]'],
    ['not json'],
    ['[{"productPath":"x"}]'],
    ['[{"productPath":"x","installationVersion":"bad"}]']
  ])('returns null for %s', (stdout) => {
    expect(parseVswhere(stdout)).toBeNull()
  })
})
