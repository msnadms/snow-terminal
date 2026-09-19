import { describe, expect, it } from 'vitest'
import { pullRequestUrl, webUrl } from '../src/main/forge'

describe('webUrl', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['https://user@gitlab.com/group/sub/repo/', 'https://gitlab.com/group/sub/repo'],
    ['ssh://git@bitbucket.org/team/repo.git', 'https://bitbucket.org/team/repo'],
    ['git@ssh.dev.azure.com:v3/org/project/repo', 'https://dev.azure.com/org/project/_git/repo'],
    [
      'org@vs-ssh.visualstudio.com:v3/org/project/repo',
      'https://org.visualstudio.com/project/_git/repo'
    ]
  ])('normalizes %s', (raw, expected) => {
    expect(webUrl(raw)?.href).toBe(expected)
  })

  it('rejects empty and unparseable remotes', () => {
    expect(webUrl('')).toBeNull()
    expect(webUrl('   ')).toBeNull()
    expect(webUrl('not a url')).toBeNull()
  })
})

describe('pullRequestUrl', () => {
  const repo = (raw: string): URL => webUrl(raw) as URL

  it('builds a GitHub compare URL with encoded refs', () => {
    expect(pullRequestUrl(repo('git@github.com:o/r.git'), 'feat/a b', 'main', '')).toBe(
      'https://github.com/o/r/compare/main...feat/a%20b?expand=1'
    )
  })

  it('builds GitLab, Bitbucket and Azure URLs', () => {
    expect(pullRequestUrl(repo('https://gitlab.com/g/r'), 'x', 'main', '')).toBe(
      'https://gitlab.com/g/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=x'
    )
    expect(pullRequestUrl(repo('https://bitbucket.org/t/r'), 'x', 'main', '')).toBe(
      'https://bitbucket.org/t/r/pull-requests/new?source=x&dest=main'
    )
    expect(pullRequestUrl(repo('https://dev.azure.com/o/p/_git/r'), 'x', 'main', '')).toBe(
      'https://dev.azure.com/o/p/_git/r/pullrequestcreate?sourceRef=x&targetRef=main'
    )
  })

  it('matches hosts on whole dot-delimited labels', () => {
    expect(pullRequestUrl(repo('https://github.example.com/o/r'), 'x', 'main', '')).toContain(
      '/compare/'
    )
    expect(pullRequestUrl(repo('https://mygithub.com/o/r'), 'x', 'main', '')).toBeNull()
    expect(pullRequestUrl(repo('https://git.internal/o/r'), 'x', 'main', '')).toBeNull()
  })

  it('prefers the configured template and substitutes every placeholder', () => {
    expect(
      pullRequestUrl(
        repo('https://git.internal/o/r'),
        'feat/x',
        'main',
        '{repo}/pr/new?from={branch}&to={base}'
      )
    ).toBe('https://git.internal/o/r/pr/new?from=feat/x&to=main')
  })
})
