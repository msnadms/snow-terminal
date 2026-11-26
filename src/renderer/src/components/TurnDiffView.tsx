import { useEffect, useRef, useState } from 'react'
import DiffBody from './DiffBody'
import DiffScroll from './DiffScroll'
import type { TabTurn } from '@renderer/appModel'
import { useLatestRun } from '@renderer/useLatestRun'

type TurnDiff = NonNullable<Awaited<ReturnType<typeof window.api.git.turnDiff>>>

interface TurnDiffViewProps {
  active: boolean
  turn: TabTurn
  onOpenCommit?: (cwd: string, hash: string) => void
  onClose: () => void
}

function startedAt(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function TurnDiffView({
  active,
  turn,
  onOpenCommit,
  onClose
}: TurnDiffViewProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<{
    base: string
    diff: TurnDiff | null
    error: 'missing' | 'failed' | null
  } | null>(null)
  const [changes, setChanges] = useState(0)
  const latestRun = useLatestRun()
  const { root, base, end } = turn
  const loadedFor = useRef<string | null>(null)
  const current = loaded?.base === base ? loaded : null
  const diff = current?.diff ?? null
  const error = current?.error ?? null

  useEffect(() => {
    if (end) return
    window.api.git.watch(root)
    const unsubscribe = window.api.git.onChanged((changedCwd) => {
      if (changedCwd === root) setChanges((n) => n + 1)
    })
    return () => {
      unsubscribe()
      window.api.git.unwatch(root)
    }
  }, [root, end])

  useEffect(() => {
    if (!active) return
    const key = `${root}\n${base}\n${end ?? changes}`
    if (loadedFor.current === key) return
    loadedFor.current = key
    const isCurrent = latestRun()
    let applied = false
    window.api.git
      .turnDiff(root, base, end)
      .then((result) => {
        if (!isCurrent()) return
        applied = true
        setLoaded({ base, diff: result, error: result ? null : 'missing' })
      })
      .catch(() => {
        if (!isCurrent()) return
        applied = true
        setLoaded({ base, diff: null, error: 'failed' })
      })
    return () => {
      if (!applied) loadedFor.current = null
    }
  }, [active, root, base, end, changes, latestRun])

  const body = (): React.JSX.Element => {
    if (error === 'missing')
      return (
        <div className="commit-empty">
          The snapshot for this turn is no longer in the repository.
        </div>
      )
    if (error) return <div className="commit-empty">Could not load this turn&apos;s changes.</div>
    if (!diff) return <div className="commit-empty">Loading…</div>
    if (diff.files.length === 0)
      return <div className="commit-empty">No changes {end ? 'this turn' : 'yet'}</div>
    return (
      <DiffBody
        cwd={root}
        base={diff.base}
        files={diff.files}
        patch={diff.patch}
        truncated={diff.truncated}
        truncatedNote="Diff too large to display in full."
        onOpenCommit={onOpenCommit}
      />
    )
  }

  return (
    <DiffScroll active={active} onClose={onClose}>
      <div className="commit-header">
        <div className="commit-subject">
          {end ? 'Changes this turn' : turn.live ? 'Turn in progress' : 'Unfinished turn'}
        </div>
        <div className="commit-meta">
          <span className="commit-refs">
            Since {startedAt(turn.at)}
            {diff && diff.files.length > 0
              ? ` · ${diff.files.length} file${diff.files.length === 1 ? '' : 's'}`
              : ''}
            {!end && !turn.live ? ' · no end snapshot, includes later edits' : ''}
          </span>
          <span>{root}</span>
        </div>
      </div>
      {body()}
    </DiffScroll>
  )
}

export default TurnDiffView
