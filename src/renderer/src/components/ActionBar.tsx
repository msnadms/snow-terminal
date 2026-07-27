import { useEffect, useState } from 'react'
import BranchSelect from './BranchSelect'
import FailureDialog from './FailureDialog'
import WorkflowSelect from './WorkflowSelect'
import { type Failure } from '@renderer/format'
import { useGitAction } from '@renderer/useGitAction'
import { useLatestRun } from '@renderer/useLatestRun'

interface ActionBarProps {
  cwd?: string
  frozen: boolean
  onFreeze: (frozen: boolean) => void
  onOpenPullRequest: (url: string) => void
}

type GitStatus = Awaited<ReturnType<typeof window.api.git.status>>
type GitUndo = Awaited<ReturnType<typeof window.api.git.undoCommit>>
type GitPullRequest = Awaited<ReturnType<typeof window.api.git.openPullRequest>>

const glyphs = {
  commit: '  ',
  syncDefault: ' ',
  update: ' ',
  undo: '',
  fetch: '',
  pullRequest: '',
  freeze: ''
}

interface SyncFace {
  glyph?: string
  text?: string
  title: string
}

function syncFaceOf(tracking: string | null, ahead: number, behind: number): SyncFace {
  if (!tracking) return { text: '↑', title: 'Publish this branch' }
  if (ahead > 0 && behind > 0) return { text: '↕', title: `Diverged from ${tracking}` }
  if (ahead > 0) {
    return {
      text: `↑${ahead}`,
      title: `Push ${ahead} commit${ahead === 1 ? '' : 's'} to ${tracking}`
    }
  }
  if (behind > 0) {
    return {
      text: `↓${behind}`,
      title: `Pull ${behind} commit${behind === 1 ? '' : 's'} from ${tracking} (fast-forward)`
    }
  }
  return { glyph: glyphs.fetch, title: `Fetch from ${tracking}` }
}

function ActionBar({
  cwd,
  frozen,
  onFreeze,
  onOpenPullRequest
}: ActionBarProps): React.JSX.Element {
  const [isRepo, setIsRepo] = useState(false)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [defaultName, setDefaultName] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [raised, setRaised] = useState<{ cwd?: string; failure: Failure } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const latestRun = useLatestRun()

  const message = drafts[cwd ?? ''] ?? ''
  const failure = raised && raised.cwd === cwd ? raised.failure : null

  const setMessage = (next: string): void => setDrafts((prev) => ({ ...prev, [cwd ?? '']: next }))
  const setFailure = (next: Failure | null): void => setRaised(next ? { cwd, failure: next } : null)

  const bump = (): void => setRefreshKey((key) => key + 1)
  const refresh = { onFailure: setFailure, onSettled: bump }
  const commit = useGitAction({ onSettled: bump })
  const syncDefault = useGitAction(refresh)
  const update = useGitAction(refresh)
  const sync = useGitAction(refresh)
  const undo = useGitAction<GitUndo>(refresh)
  const pullRequest = useGitAction<GitPullRequest>({ onFailure: setFailure })
  const actions = [commit, syncDefault, update, sync, undo, pullRequest]

  useEffect(() => {
    if (!frozen || !cwd) return
    window.api.git.watch(cwd)
    return () => {
      window.api.git.unwatch(cwd)
    }
  }, [frozen, cwd])

  useEffect(() => {
    const check = async (): Promise<void> => {
      const isCurrent = latestRun()
      const repo = cwd ? await window.api.git.isRepo(cwd) : false
      if (!isCurrent()) return
      setIsRepo(repo)
      if (!repo) {
        setStatus(null)
        setDefaultName(null)
        return
      }
      try {
        const [gitStatus, name] = await Promise.all([
          window.api.git.status(cwd),
          window.api.git.defaultBranch(cwd)
        ])
        if (!isCurrent()) return
        setStatus(gitStatus)
        setDefaultName(name)
      } catch {
        if (!isCurrent()) return
        setStatus(null)
        setDefaultName(null)
      }
    }

    check()
    const offChanged = window.api.git.onChanged(() => check())
    const offIgnore = window.api.snowignore.onChanged(() => check())

    return () => {
      offChanged()
      offIgnore()
    }
  }, [cwd, refreshKey, latestRun])

  const current = status?.current ?? null
  const tracking = status?.tracking ?? null
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  const ready = (status?.stageable ?? 0) > 0
  const ignoreError = status?.ignoreError ?? null
  const onDefault = defaultName !== null && current === defaultName

  const busy = actions.some((action) => action.pending)

  const canSubmit = ready && !busy && message.trim() !== ''
  const canSyncDefault = isRepo && !busy
  const canUpdate = isRepo && !busy && !onDefault
  const canSync = isRepo && !busy && current !== null
  const showUndo = isRepo && current !== null && (ahead > 0 || !tracking)
  const showPullRequest = isRepo && current !== null && tracking !== null && current !== defaultName

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    const result = await commit.run(() => window.api.git.commitPush(cwd, message.trim()))
    if (result?.ok) setMessage('')
  }

  const runUndo = async (): Promise<void> => {
    const result = await undo.run(() => window.api.git.undoCommit(cwd))
    if (!result?.ok) return
    setMessage(result.subject ?? '')
    if (result.body) {
      setFailure({ title: 'Commit undone — its body was not restored', detail: result.body })
    }
  }

  const face = syncFaceOf(tracking, ahead, behind)

  return (
    <div className="actionbar">
      <input
        className="actionbar-input"
        placeholder="Commit message"
        title={ignoreError ?? undefined}
        value={message}
        disabled={!ready || busy}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button
        className={`actionbar-button${commit.className}`}
        disabled={!canSubmit}
        onClick={submit}
        title={commit.error || ignoreError || 'Add, Commit, Push'}
      >
        <div className="nerd-glyph">{glyphs.commit}</div>
      </button>
      {showUndo && (
        <button
          className={`actionbar-button${undo.className}`}
          disabled={busy}
          onClick={runUndo}
          title={undo.error || 'Undo last commit — its changes stay in the worktree'}
        >
          <div className="nerd-glyph">{glyphs.undo}</div>
        </button>
      )}
      <div className="actionbar-divider" />
      <button
        className={`actionbar-button${syncDefault.className}`}
        disabled={!canSyncDefault}
        onClick={() => syncDefault.run(() => window.api.git.syncDefault(cwd))}
        title={
          syncDefault.error ||
          (onDefault
            ? 'Fast-forward the default branch from its remote'
            : "Fetch and check out the remote's default branch")
        }
      >
        <div className="nerd-glyph">{glyphs.syncDefault}</div>
      </button>
      <button
        className={`actionbar-button${update.className}`}
        disabled={!canUpdate}
        onClick={() => update.run(() => window.api.git.updateFromDefault(cwd))}
        title={
          update.error ||
          (onDefault
            ? 'Already on the default branch'
            : "Merge the remote's default branch into the current branch")
        }
      >
        <div className="nerd-glyph">{glyphs.update}</div>
      </button>
      <div className="actionbar-divider" />
      <button
        className={`actionbar-button${sync.className}`}
        disabled={!canSync}
        onClick={() => sync.run(() => window.api.git.sync(cwd))}
        title={sync.error || face.title}
      >
        {face.glyph ? (
          <div className="nerd-glyph">{face.glyph}</div>
        ) : (
          <div className="actionbar-count">{face.text}</div>
        )}
      </button>
      {showPullRequest && (
        <button
          className={`actionbar-button${pullRequest.className}`}
          disabled={busy}
          onClick={async () => {
            const result = await pullRequest.run(() => window.api.git.openPullRequest(cwd))
            if (result?.ok && result.url) onOpenPullRequest(result.url)
          }}
          title={pullRequest.error || 'Open a pull request'}
        >
          <div className="nerd-glyph">{glyphs.pullRequest}</div>
        </button>
      )}
      <div className="actionbar-right">
        <WorkflowSelect key={`workflow-${cwd ?? 'none'}`} cwd={cwd} />
        <BranchSelect key={cwd ?? 'none'} cwd={cwd} />
        <button
          className={`actionbar-button actionbar-freeze${frozen ? ' actionbar-freeze-on' : ''}`}
          aria-pressed={frozen}
          onClick={() => onFreeze(!frozen)}
          title={
            frozen
              ? 'Git view frozen — click to follow the active tab again'
              : 'Freeze the git view on the current directory'
          }
        >
          <div className="nerd-glyph">{glyphs.freeze}</div>
        </button>
      </div>
      {failure && <FailureDialog failure={failure} onDismiss={() => setFailure(null)} />}
    </div>
  )
}

export default ActionBar
