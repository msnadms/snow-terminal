import { useEffect, useState } from 'react'
import { shortHash } from '@renderer/format'
import DiffBody from './DiffBody'
import DiffScroll from './DiffScroll'

type GitCommitDetail = Awaited<ReturnType<typeof window.api.git.show>>

interface CommitViewProps {
  active: boolean
  cwd: string
  hash: string
  onOpenCommit?: (cwd: string, hash: string) => void
}

function CommitView({ active, cwd, hash, onOpenCommit }: CommitViewProps): React.JSX.Element {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    window.api.git
      .show(cwd, hash)
      .then((result) => {
        if (cancelled) return
        setDetail(result)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setDetail(null)
        setError('Could not read commit')
      })

    return () => {
      cancelled = true
    }
  }, [cwd, hash])

  const body = (): React.JSX.Element => {
    if (error) return <div className="commit-empty">{error}</div>
    if (!detail) return <div className="commit-empty">Loading…</div>

    return (
      <>
        <div className="commit-header">
          <div className="commit-subject">{detail.subject}</div>
          {detail.body && <pre className="commit-body">{detail.body}</pre>}
          <div className="commit-meta">
            <span className="commit-hash">{detail.hash}</span>
            <span className="commit-author">
              {detail.author}
              {detail.email && ` <${detail.email}>`}
            </span>
            <span>{new Date(detail.date).toLocaleString()}</span>
          </div>
          <div className="commit-meta">
            {detail.parents.length > 0 && (
              <span>
                {detail.parents.length > 1 ? 'parents' : 'parent'}{' '}
                {detail.parents.map(shortHash).join(' ')}
              </span>
            )}
            {detail.refs && <span className="commit-refs">{detail.refs}</span>}
          </div>
        </div>

        <DiffBody
          cwd={cwd}
          base={detail.parents[0] ?? null}
          files={detail.files}
          patch={detail.patch}
          truncated={detail.truncated}
          truncatedNote={`Diff too large to display in full — open ${shortHash(detail.hash)} in a shell to see the rest.`}
          onOpenCommit={onOpenCommit}
        />
      </>
    )
  }

  return <DiffScroll active={active}>{body()}</DiffScroll>
}

export default CommitView
