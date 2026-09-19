import { useState } from 'react'
import { directoryKey } from '@renderer/workflowRows'
import type { WorkflowRepo } from '@renderer/workflowText'

export type RepoDrag = {
  repo: string
  target: string
  after: boolean
}

export interface RepoOrder {
  drag: RepoDrag | null
  begin: (e: React.DragEvent<HTMLElement>, repo: string) => void
  over: (e: React.DragEvent<HTMLElement>, target: string) => void
  drop: (e: React.DragEvent<HTMLElement>, target: string) => void
  end: () => void
  nudge: (repo: string, offset: -1 | 1) => void
}

export function useRepoOrder(
  repos: WorkflowRepo[],
  vertical: boolean,
  save: (order: string[]) => void
): RepoOrder {
  const [drag, setDrag] = useState<RepoDrag | null>(null)

  const landsAfter = (e: React.DragEvent<HTMLElement>): boolean => {
    const rect = e.currentTarget.getBoundingClientRect()
    return vertical
      ? e.clientY >= rect.top + rect.height / 2
      : e.clientX >= rect.left + rect.width / 2
  }

  const move = (repo: string, target: string, after: boolean): void => {
    if (directoryKey(repo) === directoryKey(target)) return
    const next = repos
      .map((entry) => entry.repo)
      .filter((entry) => directoryKey(entry) !== directoryKey(repo))
    const targetIndex = next.findIndex((entry) => directoryKey(entry) === directoryKey(target))
    if (targetIndex < 0) return
    next.splice(targetIndex + (after ? 1 : 0), 0, repo)
    save(next)
  }

  return {
    drag,
    begin: (e, repo) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', repo)
      setDrag({ repo, target: repo, after: false })
    },
    over: (e, target) => {
      if (!drag) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const after = landsAfter(e)
      setDrag((current) =>
        current && (current.target !== target || current.after !== after)
          ? { ...current, target, after }
          : current
      )
    },
    drop: (e, target) => {
      if (!drag) return
      e.preventDefault()
      move(drag.repo, target, landsAfter(e))
      setDrag(null)
    },
    end: () => setDrag(null),
    nudge: (repo, offset) => {
      const current = repos.map((entry) => entry.repo)
      const index = current.findIndex((entry) => directoryKey(entry) === directoryKey(repo))
      const target = index + offset
      if (index < 0 || target < 0 || target >= current.length) return
      const moved = current[index]
      current[index] = current[target]
      current[target] = moved
      save(current)
    }
  }
}
