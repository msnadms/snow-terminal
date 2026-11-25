import { useEffect, useMemo, useRef, useState } from 'react'
import { parseDiff } from 'react-diff-view'
import DiffBody from './DiffBody'
import DiffScroll from './DiffScroll'
import type { CodeLinkTarget } from '@renderer/appModel'
import {
  fileIndexFor,
  linkLabel,
  rangeOf,
  selectedKeysFor,
  sourceWindow,
  type LineRange
} from '@renderer/codeLinks'
import { useLatestRun } from '@renderer/useLatestRun'

type GitDiff =
  | Awaited<ReturnType<typeof window.api.git.diff>>
  | Awaited<ReturnType<typeof window.api.git.reviewDiff>>

type Loaded =
  | { kind: 'diff'; diff: GitDiff; label: string }
  | { kind: 'file'; source: string; label: string }
  | { kind: 'missing'; reason: 'large' | 'untracked' | 'unreadable' }

interface CodeLinkViewProps {
  active: boolean
  target: CodeLinkTarget
  onOpenCommit?: (cwd: string, hash: string) => void
  onClose: () => void
}

type Inclusion = 'none' | 'listed' | 'outside' | 'shown'

function inclusion(diff: GitDiff | null, file: string, range?: LineRange): Inclusion {
  if (!diff) return 'none'
  const index = fileIndexFor(diff.files, file)
  if (index === -1) return 'none'
  const parsed = parseDiff(diff.patch)[index]
  if (!parsed) return 'listed'
  if (!range || parsed.hunks.length === 0) return 'shown'
  return selectedKeysFor(parsed.hunks, range).length > 0 ? 'shown' : 'outside'
}

async function loadTarget(root: string, file: string, range?: LineRange): Promise<Loaded> {
  const working = await window.api.git.diff(root).catch(() => null)
  const inWorking = inclusion(working, file, range)
  if (working && inWorking === 'shown')
    return { kind: 'diff', diff: working, label: 'Uncommitted changes' }

  const review = await window.api.git.reviewDiff(root).catch(() => null)
  const inReview = inclusion(review, file, range)
  if (review && inReview === 'shown')
    return { kind: 'diff', diff: review, label: `Changes since ${review.target}` }

  const changed = inWorking !== 'none' || inReview !== 'none'
  const unchanged = !changed && !!working && !!review
  const current = await window.api.git.blame(root, '', file).catch(() => null)
  if (current?.source != null)
    return {
      kind: 'file',
      source: current.source,
      label: unchanged ? 'No changes in this file' : 'Working tree'
    }

  if (working && inWorking === 'outside')
    return { kind: 'diff', diff: working, label: 'Uncommitted changes' }
  if (review && inReview === 'outside')
    return { kind: 'diff', diff: review, label: `Changes since ${review.target}` }

  const blame = await window.api.git.blame(root, 'HEAD', file).catch(() => null)
  if (blame?.source != null)
    return {
      kind: 'file',
      source: blame.source,
      label: unchanged ? 'No changes in this file' : 'HEAD'
    }
  const blamed =
    (!!current && Object.keys(current.lines).length > 0) ||
    (!!blame && Object.keys(blame.lines).length > 0)
  if (blamed) return { kind: 'missing', reason: 'large' }
  return { kind: 'missing', reason: unchanged ? 'untracked' : 'unreadable' }
}

function SourceFile({ source, range }: { source: string; range?: LineRange }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [whole, setWhole] = useState(false)
  const lines = useMemo(() => source.replace(/\n$/, '').split('\n'), [source])
  const shown = whole ? { start: 1, end: lines.length } : sourceWindow(lines.length, range)
  const partial = shown.start > 1 || shown.end < lines.length

  useEffect(() => {
    if (!range) return
    const frame = requestAnimationFrame(() => {
      hostRef.current
        ?.querySelector('.code-link-line-selected')
        ?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [range])

  return (
    <div className="code-link-source" ref={hostRef}>
      {partial && (
        <button type="button" className="code-link-more" onClick={() => setWhole(true)}>
          Lines {shown.start}–{shown.end} of {lines.length} · Show all
        </button>
      )}
      {lines.slice(shown.start - 1, shown.end).map((text, i) => {
        const n = shown.start + i
        const selected = !!range && n >= range.start && n <= range.end
        return (
          <div key={n} className={`code-link-line${selected ? ' code-link-line-selected' : ''}`}>
            <span className="code-link-number">{n}</span>
            <span className="code-link-text">{text}</span>
          </div>
        )
      })}
    </div>
  )
}

function CodeLinkView({
  active,
  target,
  onOpenCommit,
  onClose
}: CodeLinkViewProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const latestRun = useLatestRun()
  const { root, path: file } = target
  const range = useMemo(() => rangeOf(target), [target])

  const [changes, setChanges] = useState(0)
  const loadedFor = useRef<{
    changes: number
    root: string
    file: string
    range?: LineRange
  } | null>(null)

  useEffect(() => {
    window.api.git.watch(root)
    const unsubscribe = window.api.git.onChanged((changedCwd) => {
      if (changedCwd === root) setChanges((n) => n + 1)
    })
    return () => {
      unsubscribe()
      window.api.git.unwatch(root)
    }
  }, [root])

  useEffect(() => {
    if (!active) return
    const last = loadedFor.current
    if (
      last &&
      last.changes === changes &&
      last.root === root &&
      last.file === file &&
      last.range === range
    )
      return
    loadedFor.current = { changes, root, file, range }
    const isCurrent = latestRun()
    let applied = false
    loadTarget(root, file, range).then((result) => {
      if (!isCurrent()) return
      applied = true
      setLoaded(result)
    })
    return () => {
      if (!applied) loadedFor.current = null
    }
  }, [active, changes, root, file, range, latestRun])

  const body = (): React.JSX.Element => {
    if (!loaded) return <div className="commit-empty">Loading…</div>
    if (loaded.kind === 'missing')
      return (
        <div className="commit-empty">
          {loaded.reason === 'large'
            ? `${file} is too large to display.`
            : loaded.reason === 'untracked'
              ? `${file} has no changes and is not in HEAD, so git cannot show it. It may be gitignored.`
              : `git cannot show ${file}. It may be untracked or gitignored.`}
        </div>
      )
    if (loaded.kind === 'file') return <SourceFile source={loaded.source} range={range} />
    return (
      <DiffBody
        cwd={root}
        base={loaded.diff.base}
        files={loaded.diff.files}
        patch={loaded.diff.patch}
        truncated={loaded.diff.truncated}
        truncatedNote="Diff too large to display in full."
        only={file}
        focusLine={range}
        onOpenCommit={onOpenCommit}
      />
    )
  }

  return (
    <DiffScroll active={active} onClose={onClose}>
      <div className="commit-header">
        <div className="commit-subject">{linkLabel(target)}</div>
        <div className="commit-meta">
          <span className="commit-refs">
            {loaded && loaded.kind !== 'missing' ? loaded.label : ''}
          </span>
          <span>{root}</span>
        </div>
      </div>
      {body()}
    </DiffScroll>
  )
}

export default CodeLinkView
