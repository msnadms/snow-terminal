import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Diff, Hunk, parseDiff, useTokenizeWorker } from 'react-diff-view'
import type { FileData, GutterOptions, ViewType } from 'react-diff-view'
import {
  fileIndexFor,
  firstChangedLine,
  selectedKeysFor,
  type LineRange
} from '@renderer/codeLinks'
import { shortHash } from '@renderer/format'
import { languageFor } from '@renderer/syntax'
import { tokenizeWorker } from '@renderer/tokenizeWorker'
import { hasEditor, useEditors, type EditorAvailability } from '@renderer/useEditors'
import OpenInEditor from './OpenInEditor'
import 'react-diff-view/style/index.css'

type GitCommitDetail = Awaited<ReturnType<typeof window.api.git.show>>
export type DiffFileEntry = GitCommitDetail['files'][number]
type GitBlameResult = Awaited<ReturnType<typeof window.api.git.blame>>

const noHunks: FileData['hunks'] = []
const noSelection: string[] = []
const noPaths: ReadonlySet<string> = new Set()

export interface DiffStaging {
  busy: boolean
  onSetStaged: (file: DiffFileEntry, staged: boolean) => void
  onRevert: (file: DiffFileEntry) => void
}

interface DiffFileProps {
  cwd: string
  base: string | null
  file: DiffFileEntry
  diff?: FileData
  view: ViewType
  sectionRef: (node: HTMLDivElement | null) => void
  focusLine?: LineRange
  onOpenCommit?: (cwd: string, hash: string) => void
  staging?: DiffStaging
  collapsed: boolean
  onCollapse: (path: string, collapsed: boolean) => void
  editors: EditorAvailability
  worktreeLines: boolean
}

function DiffFile({
  cwd,
  base,
  file,
  diff,
  view,
  sectionRef,
  focusLine,
  onOpenCommit,
  staging,
  collapsed,
  onCollapse,
  editors,
  worktreeLines
}: DiffFileProps): React.JSX.Element {
  const [cached, setCached] = useState<{ key: string; result: GitBlameResult } | null>(null)
  const [visible, setVisible] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const language = diff ? languageFor(file.path) : null

  const blamePath = file.oldPath ?? file.path
  const blameKey = `${cwd} ${base ?? ''} ${blamePath}`
  const blame = cached && cached.key === blameKey ? cached.result : null
  const shown = visible && !collapsed

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
    if (!shown || !base || !diff || blame) return
    let cancelled = false

    window.api.git
      .blame(cwd, base, blamePath)
      .then((result) => {
        if (!cancelled) setCached({ key: blameKey, result })
      })
      .catch(() => {
        if (!cancelled) setCached({ key: blameKey, result: { lines: {}, source: null } })
      })

    return () => {
      cancelled = true
    }
  }, [shown, base, cwd, blamePath, blameKey, diff, blame])

  const payload = useMemo(
    () => ({
      hunks: shown ? (diff?.hunks ?? noHunks) : noHunks,
      oldSource: blame?.source ?? null,
      language
    }),
    [shown, diff, blame, language]
  )
  const { tokens } = useTokenizeWorker(tokenizeWorker(), payload)

  const selected = useMemo(
    () => (focusLine && diff ? selectedKeysFor(diff.hunks, focusLine) : noSelection),
    [focusLine, diff]
  )
  const outside = !!focusLine && !!diff && diff.hunks.length > 0 && selected.length === 0

  const scrolledToFocus = useRef(false)
  useEffect(() => {
    if (!shown || selected.length === 0 || scrolledToFocus.current) return
    const frame = requestAnimationFrame(() => {
      const line = hostRef.current?.querySelector('.diff-code-selected')
      if (!line) return
      scrolledToFocus.current = true
      line.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [shown, selected])

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
          onClick={() => {
            if (!/^0+$/.test(entry.hash)) onOpenCommit?.(cwd, entry.hash)
          }}
          role="presentation"
        >
          <span className="commit-blame-hash">{shortHash(entry.hash)}</span>
          <span className="commit-blame-author">{entry.author}</span>
        </span>
        {renderDefault()}
      </>
    )
  }

  const toggleCollapsed = (): void => {
    onCollapse(file.path, !collapsed)
    if (!collapsed) {
      requestAnimationFrame(() => hostRef.current?.scrollIntoView({ block: 'nearest' }))
    }
  }

  const openable = diff?.type !== 'delete' && hasEditor(editors)

  return (
    <div
      className={`commit-file-section${collapsed ? ' commit-file-collapsed' : ''}`}
      ref={(node) => {
        hostRef.current = node
        sectionRef(node)
      }}
    >
      <div
        className={`commit-file-title${staging || openable ? ' commit-file-title-actions' : ''}`}
      >
        <button
          className="commit-file-collapse"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand this file' : 'Collapse this file'}
        >
          {collapsed ? '' : ''}
        </button>
        <span className="commit-file-name">
          {file.oldPath && <span className="commit-file-old">{file.oldPath} → </span>}
          {file.path}
        </span>
        {outside && focusLine && (
          <span className="commit-file-unchanged">line {focusLine.start} is unchanged</span>
        )}
        {(staging || openable) && (
          <span className="commit-file-actions">
            {openable && (
              <OpenInEditor
                editors={editors}
                cwd={cwd}
                path={file.path}
                line={
                  worktreeLines
                    ? (focusLine?.start ?? (diff ? firstChangedLine(diff.hunks) : undefined))
                    : undefined
                }
              />
            )}
            {staging && (
              <>
                <button
                  className={`commit-toggle-button commit-file-action${file.staged ? ' commit-file-action-on' : ''}`}
                  disabled={staging.busy}
                  onClick={() => staging.onSetStaged(file, !file.staged)}
                  title={
                    file.staged
                      ? 'Unstage this file - leave its changes in the worktree'
                      : 'Stage this file'
                  }
                >
                  <div className="commit-action-icon">{file.staged ? '󱟃' : ''}</div>
                </button>
                <button
                  className="commit-toggle-button commit-file-action commit-file-action-danger"
                  disabled={staging.busy}
                  onClick={() => staging.onRevert(file)}
                  title="Discard this file's changes"
                >
                  <div className="commit-action-icon">󰕍</div>
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {!collapsed && (
        <div className="commit-file-body">
          {diff && diff.hunks.length > 0 ? (
            <Diff
              className={hasBlame ? 'diff-blame' : undefined}
              viewType={view}
              diffType={diff.type}
              hunks={diff.hunks}
              tokens={tokens}
              selectedChanges={selected}
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
  only?: string
  focusLine?: LineRange
  onOpenCommit?: (cwd: string, hash: string) => void
  staging?: DiffStaging
  worktreeLines?: boolean
}

function DiffBody({
  cwd,
  base,
  files: allFiles,
  patch,
  truncated,
  truncatedNote,
  focus,
  focusKey,
  only,
  focusLine,
  onOpenCommit,
  staging,
  worktreeLines = false
}: DiffBodyProps): React.JSX.Element {
  const [view, setView] = useState<ViewType>('unified')
  const editors = useEditors()
  const collapseKey = `${cwd}\n${base ?? ''}`
  const [collapsedFor, setCollapsedFor] = useState<{ key: string; paths: ReadonlySet<string> }>(
    () => ({ key: collapseKey, paths: noPaths })
  )
  const collapsed = collapsedFor.key === collapseKey ? collapsedFor.paths : noPaths
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([])
  const appliedFocus = useRef<number | null>(null)
  const parsedAll = useMemo<FileData[]>(() => (patch ? parseDiff(patch) : []), [patch])
  const { files, parsed } = useMemo(() => {
    if (!only) return { files: allFiles, parsed: parsedAll }
    const index = fileIndexFor(allFiles, only)
    return index === -1
      ? { files: [], parsed: [] }
      : { files: [allFiles[index]], parsed: [parsedAll[index]] }
  }, [only, allFiles, parsedAll])

  const setFileCollapsed = useCallback(
    (path: string, value: boolean): void => {
      setCollapsedFor((prev) => {
        const paths = prev.key === collapseKey ? prev.paths : noPaths
        if (paths.has(path) === value) return prev
        const next = new Set(paths)
        if (value) next.add(path)
        else next.delete(path)
        return { key: collapseKey, paths: next }
      })
    },
    [collapseKey]
  )

  const allCollapsed = files.length > 0 && files.every((file) => collapsed.has(file.path))
  const toggleAll = (): void => {
    setCollapsedFor({
      key: collapseKey,
      paths: allCollapsed ? noPaths : new Set(files.map((file) => file.path))
    })
  }

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
    setFileCollapsed(files[index].path, false)
    section.scrollIntoView({ block: 'start' })
  }, [focus, focusKey, files, setFileCollapsed])

  return (
    <>
      <div className="commit-toolbar">
        <span className="commit-count">
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
        <div className="commit-toggle">
          {files.length > 1 && (
            <button className="commit-toggle-button" onClick={toggleAll}>
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
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
            onClick={() => {
              setFileCollapsed(file.path, false)
              sectionRefs.current[i]?.scrollIntoView({ block: 'start' })
            }}
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
                <span className="commit-del">-{file.deletions}</span>
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
          staging={staging}
          collapsed={collapsed.has(file.path)}
          onCollapse={setFileCollapsed}
          editors={editors}
          worktreeLines={worktreeLines}
          focusLine={only ? focusLine : undefined}
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
