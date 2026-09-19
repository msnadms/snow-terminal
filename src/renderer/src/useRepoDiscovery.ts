import { useEffect, useState } from 'react'
import type { GitRepo } from './components/GitPanel'
import { uniqueBy } from './format'

export function useRepoDiscovery(discoverKey: string): GitRepo[] | null {
  const [repos, setRepos] = useState<GitRepo[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const cwds: (string | undefined)[] = discoverKey ? discoverKey.split('\n') : [undefined]
    const load = (): void => {
      Promise.all(cwds.map((cwd) => window.api.git.discover(cwd).catch(() => [])))
        .then((results) => {
          if (!cancelled) setRepos(uniqueBy(results.flat(), (repo) => repo.path))
        })
        .catch(() => {
          if (!cancelled) setRepos([])
        })
    }
    load()
    for (const cwd of cwds) window.api.git.watchRepos(cwd)
    const offRepos = window.api.git.onReposChanged(() => load())
    return () => {
      cancelled = true
      offRepos()
      for (const cwd of cwds) window.api.git.unwatchRepos(cwd)
    }
  }, [discoverKey])

  return repos
}
