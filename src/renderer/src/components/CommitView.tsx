import { useEffect, useMemo, useRef, useState } from 'react'
import { Diff, Hunk, parseDiff } from 'react-diff-view'
import type { FileData, GutterOptions, ViewType } from 'react-diff-view'
import { shortHash } from '@renderer/format'
import 'react-diff-view/style/index.css'

type GitCommitDetail = Awaited<ReturnType<typeof window.api.git.show>>
type GitCommitFile = GitCommitDetail['files'][number]
type GitBlame = Awaited<ReturnType<typeof window.api.git.blame>>

interface CommitFileProps {
  cwd: string
  parent: string | null
  file: GitCommitFile
  diff?: FileData
  view: ViewType
  sectionRef: (node: HTMLDivElement | null) => void
  onOpenCommit?: (cwd: string, hash: string) => void
}

function CommitFile({
  cwd,
  parent,
  file,
  diff,
  view,
  sectionRef,
  onOpenCommit
}: CommitFileProps): React.JSX.Element {
  const [blame, setBlame] = useState<GitBlame | null>(null)
  const [visible, setVisible] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = hostRef.current
    if (!node || visible) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible || !parent || !diff || blame) return
    let cancelled = false

    window.api.git
      .blame(cwd, parent, file.oldPath ?? file.path)
      .then((result) => {
        if (!cancelled) setBlame(result)
      })
      .catch(() => {
        if (!cancelled) setBlame({})
      })

    return () => {
      cancelled = true
    }
  }, [visible, parent, cwd, file, diff, blame])

  const hasBlame = blame != null && Object.keys(blame).length > 0

  const renderGutter = ({ change, side, renderDefault }: GutterOptions): React.ReactNode => {
    if (!hasBlame || side !== 'old' || change.type === 'insert') return renderDefault()
    const line = change.type === 'delete' ? change.lineNumber : change.oldLineNumber
    const entry = blame?.[line]
    if (!entry) return renderDefault()
    return (
      <>
        <span
          className="commit-blame"
          onClick={() => onOpenCommit?.(cwd, entry.hash)}
          role="presentation"
        >
          <span className="commit-blame-hash">{shortHash(entry.hash)}</span>
          <span className="commit-blame-author">{entry.author}</span>
        </span>
        {renderDefault()}
      </>
    )
  }

  return (
    <div
      className="commit-file-section"
      ref={(node) => {
        hostRef.current = node
        sectionRef(node)
      }}
    >
      <div className="commit-file-title">
        {file.oldPath && <span className="commit-file-old">{file.oldPath} → </span>}
        {file.path}
      </div>
      {diff && diff.hunks.length > 0 ? (
        <Diff
          className={hasBlame ? 'diff-blame' : undefined}
          viewType={view}
          diffType={diff.type}
          hunks={diff.hunks}
          renderGutter={renderGutter}
        >
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      ) : (
        <div className="commit-file-empty">
          {file.binary ? 'Binary file not shown' : 'No textual changes'}
        </div>
      )}
    </div>
  )
}

interface CommitViewProps {
  active: boolean
  cwd: string
  hash: string
  onOpenCommit?: (cwd: string, hash: string) => void
}

function CommitView({ active, cwd, hash, onOpenCommit }: CommitViewProps): React.JSX.Element {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewType>('unified')
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([])

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

  const parsed = useMemo<FileData[]>(() => (detail?.patch ? parseDiff(detail.patch) : []), [detail])

  const body = (): React.JSX.Element => {
    if (error) return <div className="commit-empty">{error}</div>
    if (!detail) return <div className="commit-empty">Loading…</div>

    const parent = detail.parents[0] ?? null

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

        <div className="commit-toolbar">
          <span className="commit-count">
            {detail.files.length} {detail.files.length === 1 ? 'file' : 'files'}
          </span>
          <div className="commit-toggle">
            <button
              className={`commit-toggle-button${view === 'unified' ? ' commit-toggle-active' : ''}`}
              onClick={() => setView('unified')}
            >
              Unified
            </button>
            <button
              className={`commit-toggle-button${view === 'split' ? ' commit-toggle-active' : ''}`}
              onClick={() => setView('split')}
            >
              Split
            </button>
          </div>
        </div>

        <div className="commit-files">
          {detail.files.map((file, i) => (
            <button
              key={`${file.path}-${i}`}
              className="commit-file-row"
              onClick={() => sectionRefs.current[i]?.scrollIntoView({ block: 'start' })}
            >
              <span className="commit-file-path">
                {file.oldPath && <span className="commit-file-old">{file.oldPath} → </span>}
                {file.path}
              </span>
              {file.binary ? (
                <span className="commit-file-binary">binary</span>
              ) : (
                <span className="commit-file-stat">
                  <span className="commit-add">+{file.additions}</span>
                  <span className="commit-del">−{file.deletions}</span>
                </span>
              )}
            </button>
          ))}
        </div>

        {detail.files.map((file, i) => (
          <CommitFile
            key={`${file.path}-${i}`}
            cwd={cwd}
            parent={parent}
            file={file}
            diff={parsed[i]}
            view={view}
            onOpenCommit={onOpenCommit}
            sectionRef={(node) => {
              sectionRefs.current[i] = node
            }}
          />
        ))}

        {detail.truncated && (
          <div className="commit-truncated">
            Diff too large to display in full — open {shortHash(detail.hash)} in a shell to see the
            rest.
          </div>
        )}
      </>
    )
  }

  return (
    <div className="commit-view" style={{ display: active ? 'block' : 'none' }}>
      {body()}
    </div>
  )
}

export default CommitView
