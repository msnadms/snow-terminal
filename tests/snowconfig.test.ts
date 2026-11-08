import { describe, expect, it } from 'vitest'
import { shellQuote } from '../src/main/commitMessage'
import { externalProtocolEntry } from '../src/main/snowconfig'

describe('externalProtocolEntry', () => {
  it('accepts a bare protocol and an origin-scoped one', () => {
    expect(externalProtocolEntry(' Slack: ')).toBe('slack:')
    expect(externalProtocolEntry('https://zoom.us  zoommtg:')).toBe('https://zoom.us zoommtg:')
  })

  it('refuses malformed origins and protocols', () => {
    expect(externalProtocolEntry('slack')).toBeNull()
    expect(externalProtocolEntry('null zoommtg:')).toBeNull()
    expect(externalProtocolEntry('https://zoom.us/path zoommtg:')).toBeNull()
    expect(externalProtocolEntry('file:///c zoommtg:')).toBeNull()
    expect(externalProtocolEntry('a b c:')).toBeNull()
  })
})

describe('shellQuote', () => {
  it('quotes only arguments the shell would split or interpret', () => {
    expect(shellQuote('-p')).toBe('-p')
    expect(shellQuote('C:/Users/a b/x.txt')).toBe('"C:/Users/a b/x.txt"')
    expect(shellQuote('a&b')).toBe('"a&b"')
  })

  it('refuses an embedded quote', () => {
    expect(() => shellQuote('a"b')).toThrow()
  })
})
