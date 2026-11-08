import { useEffect, useMemo, useRef, useState } from 'react'
import type { Tab } from './appModel'
import type { GitRepo } from './components/GitPanel'
import { isInside, normalizePath, uniqueBy } from './format'

export function useTabGroups(
  tabs: Tab[],
  tabCwd: (tab: Tab) => string | undefined,
  repos: GitRepo[] | null
): Record<number, string | null> {
  const [roots, setRoots] = useState<Record<string, string | null>>({})
  const [rootsEpoch, setRootsEpoch] = useState(0)
  const rootsRef = useRef(roots)
  useEffect(() => {
    rootsRef.current = roots
  }, [roots])
  const rootsKey = useMemo(
    () =>
      uniqueBy(
        tabs.map(tabCwd).filter((dir): dir is string => dir != null),
        (dir) => dir
      ).join('\n'),
    [tabs, tabCwd]
  )

  useEffect(
    () =>
      window.api.git.onReposChanged(() => {
        setRoots({})
        setRootsEpoch((epoch) => epoch + 1)
      }),
    []
  )

  useEffect(() => {
    let cancelled = false
    const dirs = (rootsKey ? rootsKey.split('\n') : []).filter((dir) => !(dir in rootsRef.current))
    if (dirs.length === 0) return
    Promise.all(
      dirs.map(async (dir) => {
        const owner = (repos ?? []).find((repo) =>
          isInside(normalizePath(dir), normalizePath(repo.path))
        )
        try {
          const root = owner ? owner.common : await window.api.git.mainRoot(dir)
          return [[dir, root] as const]
        } catch {
          return []
        }
      })
    ).then((resolved) => {
      if (!cancelled) setRoots((prev) => ({ ...prev, ...Object.fromEntries(resolved.flat()) }))
    })
    return () => {
      cancelled = true
    }
  }, [rootsKey, rootsEpoch, repos])

  return useMemo(() => {
    const result: Record<number, string | null> = {}
    for (const tab of tabs) {
      const dir = tabCwd(tab)
      const root = dir ? roots[dir] : null
      const presetName = tab.kind === 'shell' ? tab.presetName : undefined
      result[tab.id] = root || (presetName ? `preset:${presetName}` : null)
    }
    return result
  }, [tabs, tabCwd, roots])
}
