import { useEffect, useState } from 'react'

type GitLog = Awaited<ReturnType<typeof window.api.git.log>>
type GitStatus = Awaited<ReturnType<typeof window.api.git.status>>

function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

function GitPanel({ cwd }: { cwd?: string }): React.JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitLog | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        const isRepo = await window.api.git.isRepo(cwd)
        if (cancelled) return
        if (!isRepo) {
          setError('Not a git repository')
          setStatus(null)
          setLog(null)
          return
        }
        const [s, l] = await Promise.all([window.api.git.status(cwd), window.api.git.log(cwd)])
        if (cancelled) return
        setStatus(s)
        setLog(l)
        setError(null)
      } catch {
        if (cancelled) return
        setError('Not a git repository')
        setStatus(null)
        setLog(null)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [cwd])

  if (error) {
    return (
      <div className="git-panel">
        <div className="git-empty">{error}</div>
      </div>
    )
  }

  const changed = status
    ? status.staged.length +
      status.modified.length +
      status.not_added.length +
      status.conflicted.length
    : 0

  return (
    <div className="git-panel">
      <div className="git-header">
        <span className="git-branch">{status?.current ?? '—'}</span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="git-track">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        {changed > 0 && <span className="git-dirty">{changed} changed</span>}
      </div>

      <div className="git-log">
        {log?.commits.map((c) => (
          <div key={c.hash} className="git-commit">
            <span className="git-dot" />
            <span className="git-commit-body">
              <span className="git-subject">{c.subject}</span>
              <span className="git-meta">
                <span className="git-hash">{shortHash(c.hash)}</span>
                <span className="git-author">{c.author}</span>
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default GitPanel
