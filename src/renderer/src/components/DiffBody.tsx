import { useEffect, useMemo, useRef, useState } from 'react'
import { Diff, Hunk, parseDiff, useTokenizeWorker } from 'react-diff-view'
import type { FileData, GutterOptions, ViewType } from 'react-diff-view'
import { shortHash } from '@renderer/format'
import { languageFor } from '@renderer/syntax'
import 'react-diff-view/style/index.css'

type GitCommitDetail = Awaited<ReturnType<typeof window.api.git.show>>
export type DiffFileEntry = GitCommitDetail['files'][number]
type GitBlameResult = Awaited<ReturnType<typeof window.api.git.blame>>

let worker: Worker | null = null

function tokenizeWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../tokenize.worker.ts', import.meta.url), { type: 'module' })
  }
  return worker
}

const noHunks: FileData['hunks'] = []

interface DiffFileProps {
  cwd: string
  base: string | null
  file: DiffFileEntry
  diff?: FileData
  view: ViewType
  sectionRef: (node: HTMLDivElement | null) => void
  onOpenCommit?: (cwd: string, hash: string) => void
}

function DiffFile({
  cwd,
  base,
  file,
  diff,
  view,
  sectionRef,
  onOpenCommit
}: DiffFileProps): React.JSX.Element {
  const [blame, setBlame] = useState<GitBlameResult | null>(null)
  const [visible, setVisible] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const language = diff ? languageFor(file.path) : null

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
    if (!visible || !base || !diff || blame) return
    let cancelled = false

    window.api.git
      .blame(cwd, base, file.oldPath ?? file.path)
      .then((result) => {
        if (!cancelled) setBlame(result)
      })
      .catch(() => {
        if (!cancelled) setBlame({ lines: {}, source: null })
      })

    return () => {
      cancelled = true
    }
  }, [visible, base, cwd, file, diff, blame])

  const payload = useMemo(
    () => ({
      hunks: visible ? (diff?.hunks ?? noHunks) : noHunks,
      oldSource: blame?.source ?? null,
      language
    }),
    [visible, diff, blame, language]
  )
  const { tokens } = useTokenizeWorker(tokenizeWorker(), payload)

  const lines = blame?.lines
  const hasBlame = lines != null && Object.keys(lines).length > 0

  const renderGutter = ({ change, side, renderDefault }: GutterOptions): React.ReactNode => {
    if (!hasBlame || side !== 'old' || change.type === 'insert') return renderDefault()
    const line = change.type === 'delete' ? change.lineNumber : change.oldLineNumber
    const entry = lines?.[line]
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
          tokens={tokens}
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

interface DiffBodyProps {
  cwd: string
  base: string | null
  files: DiffFileEntry[]
  patch: string
  truncated: boolean
  truncatedNote: string
  focus?: string
  focusKey?: number
  onOpenCommit?: (cwd: string, hash: string) => void
}

function DiffBody({
  cwd,
  base,
  files,
  patch,
  truncated,
  truncatedNote,
  focus,
  focusKey,
  onOpenCommit
}: DiffBodyProps): React.JSX.Element {
  const [view, setView] = useState<ViewType>('unified')
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([])
  const appliedFocus = useRef<number | null>(null)
  const parsed = useMemo<FileData[]>(() => (patch ? parseDiff(patch) : []), [patch])

  useEffect(() => {
    if (focusKey === undefined || focusKey === appliedFocus.current) return
    if (!focus) {
      appliedFocus.current = focusKey
      return
    }
    const index = files.findIndex((file) => file.path === focus || file.oldPath === focus)
    const section = index === -1 ? null : sectionRefs.current[index]
    if (!section) {
      if (files.length > 0) appliedFocus.current = focusKey
      return
    }
    appliedFocus.current = focusKey
    section.scrollIntoView({ block: 'start' })
  }, [focus, focusKey, files])

  return (
    <>
      <div className="commit-toolbar">
        <span className="commit-count">
          {files.length} {files.length === 1 ? 'file' : 'files'}
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
        {files.map((file, i) => (
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

      {files.map((file, i) => (
        <DiffFile
          key={`${file.path}-${i}`}
          cwd={cwd}
          base={base}
          file={file}
          diff={parsed[i]}
          view={view}
          onOpenCommit={onOpenCommit}
          sectionRef={(node) => {
            sectionRefs.current[i] = node
          }}
        />
      ))}

      {truncated && <div className="commit-truncated">{truncatedNote}</div>}
    </>
  )
}

export default DiffBody
