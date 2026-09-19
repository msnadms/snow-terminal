import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { filterPaths, snowignorePath } from '../src/main/snowignore'

let scratch = ''
const original = process.env.XDG_CONFIG_HOME

function writeIgnore(contents: string): void {
  fs.mkdirSync(path.dirname(snowignorePath()), { recursive: true })
  fs.writeFileSync(snowignorePath(), contents)
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snow-ignore-test-'))
  process.env.XDG_CONFIG_HOME = scratch
})

afterAll(() => {
  if (original === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = original
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('filterPaths', () => {
  it('passes everything through when no file exists', () => {
    expect(filterPaths(['a', 'secrets.env'])).toEqual(['a', 'secrets.env'])
  })

  it('applies gitignore syntax and ignores comments', () => {
    writeIgnore('# comment\nsecrets.env\nnotes/**\n')
    expect(filterPaths(['src/a.ts', 'secrets.env', 'nested/secrets.env', 'notes/todo.md'])).toEqual(
      ['src/a.ts']
    )
  })

  it('normalizes backslashes and leading ./', () => {
    writeIgnore('notes/**\n')
    expect(filterPaths(['notes\\todo.md', './notes/x', 'keep.md'])).toEqual(['keep.md'])
  })

  it('picks up an edit without a watcher', () => {
    writeIgnore('a.txt\n')
    expect(filterPaths(['a.txt', 'bb.txt'])).toEqual(['bb.txt'])
    writeIgnore('bb.txt\n# longer so the size stamp changes\n')
    expect(filterPaths(['a.txt', 'bb.txt'])).toEqual(['a.txt'])
  })
})
