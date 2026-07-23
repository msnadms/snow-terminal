import { useEffect, useMemo, useState } from 'react'
import { useGitColors } from '../useGitColors'

type GitLog = Awaited<ReturnType<typeof window.api.git.log>>
type GitStatus = Awaited<ReturnType<typeof window.api.git.status>>
type GitCommit = GitLog['commits'][number]
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

function shortHash(hash: string): string {
  return hash.slice(0, 7)
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

interface Tip {
  commit: GitCommit
  x: number
  y: number
}

interface RepoSectionProps {
  repo: GitRepo
  multi: boolean
  lanes: string[]
  maxCommits: number
}

function RepoSection({ repo, multi, lanes, maxCommits }: RepoSectionProps): React.JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitLog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const [expanded, setExpanded] = useState(true)
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

    return () => {
      cancelled = true
      offChanged()
      window.api.git.unwatch(cwd)
    }
  }, [cwd, maxCommits])

  const edges = useMemo(() => (log ? buildEdges(log.commits, lanes) : []), [log, lanes])

  if (error) {
    return <div className="git-empty">{error}</div>
  }

  const changed = status
    ? status.staged.length +
      status.modified.length +
      status.not_added.length +
      status.conflicted.length
    : 0

  const commits = log?.commits ?? []
  const graphWidth = PADX + (log?.laneCount ?? 1) * LANE
  const graphHeight = commits.length * ROW

  const header = (
    <>
      {multi && <span className={open ? 'git-caret git-caret-open' : 'git-caret'}>▸</span>}
      {multi && <span className="git-repo-name">{repo.name}</span>}
      <span className="git-branch">{status?.current ?? '—'}</span>
      {status && (status.ahead > 0 || status.behind > 0) && (
        <span className="git-track">
          {status.ahead > 0 && `↑${status.ahead}`}
          {status.behind > 0 && `↓${status.behind}`}
        </span>
      )}
      {changed > 0 && <span className="git-dirty">{changed} changed</span>}
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

      {open && (
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

function GitPanel({ cwd }: { cwd?: string }): React.JSX.Element {
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
          />
        ))}
      </div>
    </div>
  )
}

export default GitPanel
