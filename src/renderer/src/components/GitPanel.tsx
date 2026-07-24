import { useEffect, useMemo, useState } from 'react'
import { shortHash } from '../format'
import { useGitColors } from '../useGitColors'

type GitLog = Awaited<ReturnType<typeof window.api.git.log>>
type GitStatus = Awaited<ReturnType<typeof window.api.git.status>>
type GitCommit = GitLog['commits'][number]
type GitStatusFile = GitStatus['files'][number]
type GitRepo = Awaited<ReturnType<typeof window.api.git.discover>>[number]

const ROW = 30
const LANE = 16
const PADX = 12
const DOT = 4
const GLOW_LENGTH = 22
const GLOW_PERIOD = ROW * 4
const GLOW_DURATION = 6
const SINGLE_REPO_COMMITS = 200
const MULTI_REPO_COMMITS = 10

const fallbackLanes = ['#917ec8', '#7791c5', '#c7b06b', '#a387c9']

function laneColor(lanes: string[], col: number): string {
  return lanes[col % lanes.length]
}

function laneX(col: number): number {
  return PADX + col * LANE + LANE / 2
}

function rowY(row: number): number {
  return row * ROW + ROW / 2
}

interface Edge {
  path: string
  color: string
  y: number
}

function edgePath(fromCol: number, fromRow: number, toCol: number, toRow: number): string {
  const xf = laneX(fromCol)
  const yf = rowY(fromRow)
  const xt = laneX(toCol)
  const yt = rowY(toRow)
  if (fromCol === toCol) return `M ${xf} ${yf} L ${xt} ${yt}`
  const bendY = Math.min(yf + ROW, yt)
  const mid = (yf + bendY) / 2
  const curve = `M ${xf} ${yf} C ${xf} ${mid}, ${xt} ${mid}, ${xt} ${bendY}`
  return bendY < yt ? `${curve} L ${xt} ${yt}` : curve
}

function buildEdges(commits: GitCommit[], lanes: string[]): Edge[] {
  const byHash = new Map(commits.map((c) => [c.hash, c]))
  const edges: Edge[] = []
  for (const commit of commits) {
    for (const parentHash of commit.parents) {
      const parent = byHash.get(parentHash)
      if (!parent || parent.row <= commit.row) continue
      edges.push({
        path: edgePath(commit.col, commit.row, parent.col, parent.row),
        color: laneColor(lanes, parent.col),
        y: rowY(commit.row)
      })
    }
  }
  return edges
}

const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

const codeLabels: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
  U: 'unmerged'
}

const categoryClasses = ['git-file-conflict', 'git-file-staged', '', 'git-file-untracked']

function fileCategory(file: GitStatusFile): number {
  if (conflictCodes.has(`${file.index}${file.working_dir}`)) return 0
  if (file.index === '?') return 3
  return file.working_dir.trim() ? 2 : 1
}

function groupFiles(files: GitStatusFile[]): GitStatusFile[][] {
  const groups: GitStatusFile[][] = [[], [], [], []]
  for (const file of files) groups[fileCategory(file)].push(file)
  return groups.filter((group) => group.length > 0)
}

function fileCode(file: GitStatusFile): string {
  if (conflictCodes.has(`${file.index}${file.working_dir}`)) return 'U'
  if (file.index === '?') return '?'
  return file.working_dir.trim() || file.index.trim() || '·'
}

function fileMissing(file: GitStatusFile): boolean {
  return fileCode(file) === 'D'
}

function fileClass(file: GitStatusFile): string {
  const classes = ['git-file', categoryClasses[fileCategory(file)]].filter(Boolean)
  if (file.ignored) classes.push('git-file-ignored')
  if (fileMissing(file)) classes.push('git-file-missing')
  return classes.join(' ')
}

function baseName(filePath: string): string {
  const cut = filePath.replace(/\/+$/, '').lastIndexOf('/')
  return cut === -1 ? filePath : filePath.slice(cut + 1)
}

function pathSuffix(parts: string[], depth: number): string {
  return parts.slice(Math.max(0, parts.length - depth)).join('/')
}

function fileLabels(paths: string[]): Map<string, string> {
  const parts = new Map(paths.map((p) => [p, p.split('/').filter(Boolean)]))
  const labels = new Map<string, string>()
  for (const filePath of paths) {
    const own = parts.get(filePath) ?? []
    let depth = 1
    while (
      depth < own.length &&
      paths.some(
        (other) =>
          other !== filePath && pathSuffix(parts.get(other) ?? [], depth) === pathSuffix(own, depth)
      )
    )
      depth++
    labels.set(filePath, pathSuffix(own, depth))
  }
  return labels
}

function statusLabel(file: GitStatusFile): string {
  const suffix = file.ignored ? ' — skipped by .snowignore' : ''
  if (conflictCodes.has(`${file.index}${file.working_dir}`)) return `conflicted${suffix}`
  if (file.index === '?') return `untracked${suffix}`
  const parts: string[] = []
  if (file.index.trim()) parts.push(`${codeLabels[file.index] ?? file.index} in index`)
  if (file.working_dir.trim())
    parts.push(`${codeLabels[file.working_dir] ?? file.working_dir} in worktree`)
  return `${parts.join(', ')}${suffix}`
}

function fileTitle(file: GitStatusFile): string {
  const path = file.from ? `${file.from} → ${file.path}` : file.path
  return `${path}\n${statusLabel(file)}`
}

interface Tip {
  commit: GitCommit
  x: number
  y: number
}

type OpenCommit = (cwd: string, hash: string) => void
type OpenDiff = (cwd: string, branch: string, file?: string) => void

interface RepoSectionProps {
  repo: GitRepo
  multi: boolean
  lanes: string[]
  maxCommits: number
  onOpenCommit?: OpenCommit
  onOpenDiff?: OpenDiff
}

function RepoSection({
  repo,
  multi,
  lanes,
  maxCommits,
  onOpenCommit,
  onOpenDiff
}: RepoSectionProps): React.JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitLog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const [expanded, setExpanded] = useState(true)
  const [showFiles, setShowFiles] = useState(false)
  const cwd = repo.path
  const open = !multi || expanded

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        const [s, l] = await Promise.all([
          window.api.git.status(cwd),
          window.api.git.log(cwd, maxCommits)
        ])
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
    window.api.git.watch(cwd)
    const offChanged = window.api.git.onChanged((changedCwd) => {
      if (changedCwd === cwd) load()
    })
    const offSnowignore = window.api.snowignore.onChanged(() => load())

    return () => {
      cancelled = true
      offChanged()
      offSnowignore()
      window.api.git.unwatch(cwd)
    }
  }, [cwd, maxCommits])

  const edges = useMemo(() => (log ? buildEdges(log.commits, lanes) : []), [log, lanes])
  const labels = useMemo(() => fileLabels((status?.files ?? []).map((f) => f.path)), [status])

  if (error) {
    return <div className="git-empty">{error}</div>
  }

  const branch = status?.current ?? null
  const changed = status?.stageable ?? 0
  const snowignored = (status?.changed ?? 0) - changed
  const files = status?.files ?? []
  const groups = groupFiles(files)

  const toggleFiles = (event: React.MouseEvent): void => {
    event.stopPropagation()
    setTip(null)
    if (!open) {
      setExpanded(true)
      setShowFiles(true)
      return
    }
    setShowFiles((v) => !v)
  }

  const toggleTitle = showFiles ? 'Click to show the branch tree' : 'Click to list changed files'

  const openFile = (file: GitStatusFile): void => {
    setTip(null)
    onOpenDiff?.(cwd, branch ?? 'HEAD', file.path)
  }

  const commits = log?.commits ?? []
  const graphWidth = PADX + (log?.laneCount ?? 1) * LANE
  const graphHeight = commits.length * ROW

  const header = (
    <>
      {multi && <span className={open ? 'git-caret git-caret-open' : 'git-caret'}>▸</span>}
      {multi && <span className="git-repo-name">{repo.name}</span>}
      {branch ? (
        <span
          className="git-branch git-branch-link"
          title={`${branch}\nClick to view uncommitted changes`}
          onClick={(event) => {
            event.stopPropagation()
            setTip(null)
            onOpenDiff?.(cwd, branch)
          }}
        >
          {branch}
        </span>
      ) : (
        <span className="git-branch">-</span>
      )}
      {status && (status.ahead > 0 || status.behind > 0) && (
        <span className="git-track">
          {status.ahead > 0 && `↑${status.ahead}`}
          {status.behind > 0 && `↓${status.behind}`}
        </span>
      )}
      {changed > 0 && (
        <span
          className={showFiles ? 'git-dirty git-dirty-open' : 'git-dirty'}
          title={toggleTitle}
          onClick={toggleFiles}
        >
          {changed} changed
        </span>
      )}
      {snowignored > 0 && (
        <span
          className={showFiles ? 'git-snowignored git-dirty-open' : 'git-snowignored'}
          title={toggleTitle}
          onClick={toggleFiles}
        >
          {snowignored} ignored
        </span>
      )}
    </>
  )

  return (
    <div className="git-repo">
      {multi ? (
        <button
          type="button"
          className="git-header git-header-toggle"
          aria-expanded={expanded}
          onClick={() => {
            setTip(null)
            setExpanded((v) => !v)
          }}
        >
          {header}
        </button>
      ) : (
        <div className="git-header">{header}</div>
      )}

      {open && showFiles && files.length > 0 && (
        <div className="git-files">
          {groups.map((group) => (
            <div key={group[0].path} className="git-file-group">
              {group.map((file) => {
                const name = baseName(file.path)
                const label = labels.get(file.path) ?? name
                const dir = label.slice(0, label.length - name.length)
                return (
                  <button
                    key={file.path}
                    type="button"
                    className={fileClass(file)}
                    title={fileTitle(file)}
                    onClick={() => openFile(file)}
                  >
                    <span className="git-file-code">{fileCode(file)}</span>
                    <span className="git-file-path">
                      {file.from && <span className="git-file-from">{baseName(file.from)} → </span>}
                      {dir && <span className="git-file-dir">{dir}</span>}
                      {name}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {open && !(showFiles && files.length > 0) && (
        <div className="git-log">
          <div className="git-graph" style={{ height: graphHeight }}>
            <svg
              className="git-graph-svg"
              width={graphWidth}
              height={graphHeight}
              style={{ width: graphWidth, height: graphHeight }}
            >
              {edges.map((e, i) => (
                <path
                  key={i}
                  className="git-edge"
                  d={e.path}
                  stroke={e.color}
                  strokeWidth={1.5}
                  fill="none"
                />
              ))}
              {edges.map((e, i) => (
                <path
                  key={i}
                  className="git-edge-glow"
                  d={e.path}
                  stroke="currentColor"
                  style={
                    {
                      color: e.color,
                      strokeDasharray: `${GLOW_LENGTH} ${GLOW_PERIOD - GLOW_LENGTH}`,
                      animationDuration: `${GLOW_DURATION}s`,
                      animationDelay: `${-(e.y / GLOW_PERIOD) * GLOW_DURATION}s`,
                      '--glow-period': `${GLOW_PERIOD}px`
                    } as React.CSSProperties
                  }
                />
              ))}
            </svg>

            {commits.map((c) => (
              <div key={c.hash} className="git-row" style={{ height: ROW }}>
                <span
                  className="git-node"
                  style={{
                    left: laneX(c.col),
                    width: DOT * 2,
                    height: DOT * 2,
                    background: laneColor(lanes, c.col)
                  }}
                  onMouseEnter={(ev) => {
                    const r = ev.currentTarget.getBoundingClientRect()
                    setTip({ commit: c, x: r.right + 8, y: r.top })
                  }}
                  onMouseLeave={() => setTip(null)}
                  onClick={() => onOpenCommit?.(cwd, c.hash)}
                />
                <span className="git-row-text" style={{ paddingLeft: graphWidth }}>
                  <span className="git-author">{c.author}</span>
                  <span
                    className="git-hash"
                    title="Click to copy commit hash"
                    onClick={() => navigator.clipboard.writeText(c.hash)}
                  >
                    {shortHash(c.hash)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tip && (
        <div className="git-tooltip" style={{ left: tip.x, top: tip.y }}>
          <div className="git-tooltip-subject">{tip.commit.subject}</div>
          <div className="git-tooltip-meta">
            <span className="git-hash">{shortHash(tip.commit.hash)}</span>
            <span>{tip.commit.author}</span>
          </div>
        </div>
      )}
    </div>
  )
}

interface GitPanelProps {
  cwd?: string
  onOpenCommit?: OpenCommit
  onOpenDiff?: OpenDiff
}

function GitPanel({ cwd, onOpenCommit, onOpenDiff }: GitPanelProps): React.JSX.Element {
  const [repos, setRepos] = useState<GitRepo[] | null>(null)
  const colors = useGitColors()
  const lanes = colors?.lanes ?? fallbackLanes

  useEffect(() => {
    let cancelled = false

    window.api.git
      .discover(cwd)
      .then((found) => {
        if (!cancelled) setRepos(found)
      })
      .catch(() => {
        if (!cancelled) setRepos([])
      })

    return () => {
      cancelled = true
    }
  }, [cwd])

  if (!repos) return <div className="git-panel" />

  if (repos.length === 0) {
    return (
      <div className="git-panel">
        <div className="git-empty">Not a git repository</div>
      </div>
    )
  }

  return (
    <div className="git-panel">
      <div className="git-scroll">
        {repos.map((repo) => (
          <RepoSection
            key={repo.path}
            repo={repo}
            multi={repos.length > 1}
            lanes={lanes}
            maxCommits={repos.length > 1 ? MULTI_REPO_COMMITS : SINGLE_REPO_COMMITS}
            onOpenCommit={onOpenCommit}
            onOpenDiff={onOpenDiff}
          />
        ))}
      </div>
    </div>
  )
}

export default GitPanel
