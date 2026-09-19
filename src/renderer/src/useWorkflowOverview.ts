import { useEffect, useRef, useState } from 'react'
import { normalizePath } from '@renderer/format'
import { inScope, repoScope } from '@renderer/workflowText'
import { directoryKey, openDir, type Overview } from '@renderer/workflowRows'

function splitDirectories(key: string): string[] {
  return key ? key.split('\0') : []
}

export function useWorkflowOverview(
  active: boolean,
  refreshKey: number,
  sessionDirectoryKey: string
): Overview | null {
  const [overview, setOverview] = useState<Overview | null>(null)
  const overviewRef = useRef<Overview | null>(null)
  const watchedDirsRef = useRef(new Map<string, string>())

  useEffect(() => {
    overviewRef.current = overview
  }, [overview])

  useEffect(() => {
    const repos = active ? (overview?.repos ?? []) : []
    const sessionDirectories = active ? splitDirectories(sessionDirectoryKey) : []
    const wanted = new Map<string, string>()
    for (const repo of repos) {
      wanted.set(directoryKey(repo.repo), repo.repo)
      for (const entry of repo.workflows) {
        const dir = openDir(repo, entry)
        if (!dir) continue
        wanted.set(directoryKey(dir), dir)
      }
    }
    for (const dir of sessionDirectories) wanted.set(directoryKey(dir), dir)

    for (const [key, dir] of watchedDirsRef.current) {
      if (!wanted.has(key)) window.api.git.unwatch(dir)
    }
    for (const [key, dir] of wanted) {
      if (!watchedDirsRef.current.has(key)) void window.api.git.watch(dir)
    }
    watchedDirsRef.current = wanted
  }, [overview, active, sessionDirectoryKey])

  useEffect(
    () => () => {
      for (const dir of watchedDirsRef.current.values()) window.api.git.unwatch(dir)
      watchedDirsRef.current.clear()
    },
    []
  )

  useEffect(() => {
    if (!active) return

    let stopped = false
    let running = false
    let queued = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const directories = splitDirectories(sessionDirectoryKey)

    const load = async (): Promise<void> => {
      if (running) {
        queued = true
        return
      }
      running = true
      try {
        do {
          queued = false
          const result = await window.api.workflow.overview(true, directories)
          if (stopped) return
          setOverview(result)
        } while (queued)
      } finally {
        running = false
      }
    }

    const scheduleLoad = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void load()
      }, 100)
    }

    void load()
    const offGit = window.api.git.onChanged((changedCwd) => {
      const hit =
        overviewRef.current?.repos.some((repo) =>
          inScope(changedCwd, repoScope(repo.repo, repo.workflows))
        ) || directories.some((directory) => inScope(changedCwd, [normalizePath(directory)]))
      if (hit) scheduleLoad()
    })
    const offWorkflow = window.api.workflow.onChanged(scheduleLoad)

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      offGit()
      offWorkflow()
    }
  }, [active, refreshKey, sessionDirectoryKey])

  return overview
}
