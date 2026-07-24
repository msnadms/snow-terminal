import { useEffect, useState } from 'react'
import DiffBody from './DiffBody'
import DiffScroll from './DiffScroll'

type GitWorkingDiff = Awaited<ReturnType<typeof window.api.git.diff>>

interface WorkingDiffViewProps {
  active: boolean
  cwd: string
  focus?: string
  focusKey: number
  onOpenCommit?: (cwd: string, hash: string) => void
}

function WorkingDiffView({
  active,
  cwd,
  focus,
  focusKey,
  onOpenCommit
}: WorkingDiffViewProps): React.JSX.Element {
  const [diff, setDiff] = useState<GitWorkingDiff | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        const result = await window.api.git.diff(cwd)
        if (cancelled) return
        setDiff(result)
        setError(null)
      } catch {
        if (cancelled) return
        setDiff(null)
        setError('Could not read working tree')
      }
    }

    load()
    const offChanged = window.api.git.onChanged((changedCwd) => {
      if (changedCwd === cwd) load()
    })

    return () => {
      cancelled = true
      offChanged()
    }
  }, [cwd])

  const body = (): React.JSX.Element => {
    if (error) return <div className="commit-empty">{error}</div>
    if (!diff) return <div className="commit-empty">Loading…</div>

    return (
      <>
        <div className="commit-header">
          <div className="commit-subject">Uncommitted changes</div>
          <div className="commit-meta">
            <span className="commit-refs">{diff.branch ?? 'detached HEAD'}</span>
            <span>{cwd}</span>
          </div>
        </div>

        {diff.files.length === 0 ? (
          <div className="commit-empty">Working tree clean</div>
        ) : (
          <DiffBody
            cwd={cwd}
            base="HEAD"
            files={diff.files}
            patch={diff.patch}
            truncated={diff.truncated}
            truncatedNote="Diff too large to display in full — run git diff in a shell to see the rest."
            focus={focus}
            focusKey={focusKey}
            onOpenCommit={onOpenCommit}
          />
        )}
      </>
    )
  }

  return <DiffScroll active={active}>{body()}</DiffScroll>
}

export default WorkingDiffView
