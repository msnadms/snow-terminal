import { useEffect, useState } from 'react'
import BranchSelect from './BranchSelect'
import FailureDialog from './FailureDialog'
import WorkflowSelect from './WorkflowSelect'
import { failureOf, type Failure } from '@renderer/format'
import { flashClass, useFlash } from '@renderer/useFlash'

interface ActionBarProps {
  cwd?: string
}

function ActionBar({ cwd }: ActionBarProps): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [isRepo, setIsRepo] = useState(false)
  const [onDefault, setOnDefault] = useState(false)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [pushFlash, flashPush] = useFlash()
  const [syncFlash, flashSync] = useFlash()
  const [updateFlash, flashUpdate] = useFlash()
  const [pushError, setPushError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [updateError, setUpdateError] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false

    const check = async (): Promise<void> => {
      const repo = cwd ? await window.api.git.isRepo(cwd) : false
      if (cancelled) return
      setIsRepo(repo)
      if (!repo) {
        setReady(false)
        setOnDefault(false)
        return
      }
      try {
        const [gitStatus, defaultName] = await Promise.all([
          window.api.git.status(cwd),
          window.api.git.defaultBranch(cwd)
        ])
        if (cancelled) return
        setReady(gitStatus.stageable > 0)
        setOnDefault(defaultName !== null && gitStatus.current === defaultName)
      } catch {
        if (cancelled) return
        setReady(false)
        setOnDefault(false)
      }
    }

    check()
    const offChanged = window.api.git.onChanged(() => check())
    const offIgnore = window.api.snowignore.onChanged(() => check())

    return () => {
      cancelled = true
      offChanged()
      offIgnore()
    }
  }, [cwd, refreshKey])

  const busy = pending || syncing || updating
  const canSubmit = ready && !busy && message.trim() !== ''
  const canSync = isRepo && !busy
  const canUpdate = isRepo && !busy && !onDefault

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setPending(true)
    const result = await window.api.git.commitPush(cwd, message.trim())
    setPending(false)
    setRefreshKey((key) => key + 1)
    if (result.ok) {
      setMessage('')
      setPushError('')
      flashPush('ok')
    } else {
      setPushError(result.error ?? 'git command failed')
      flashPush('error')
    }
  }

  const syncDefault = async (): Promise<void> => {
    if (!canSync) return
    setSyncing(true)
    const result = await window.api.git.syncDefault(cwd)
    setSyncing(false)
    setRefreshKey((key) => key + 1)
    if (result.ok) {
      setSyncError('')
      flashSync('ok')
      return
    }
    const next = failureOf(result)
    setSyncError(next.title)
    setFailure(next)
    flashSync('error')
  }

  const updateFromDefault = async (): Promise<void> => {
    if (!canUpdate) return
    setUpdating(true)
    const result = await window.api.git.updateFromDefault(cwd)
    setUpdating(false)
    setRefreshKey((key) => key + 1)
    if (result.ok) {
      setUpdateError('')
      flashUpdate('ok')
      return
    }
    const next = failureOf(result)
    setUpdateError(next.title)
    setFailure(next)
    flashUpdate('error')
  }

  return (
    <div className="actionbar">
      <input
        className="actionbar-input"
        placeholder="Commit message"
        value={message}
        disabled={!ready || busy}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button
        className={`actionbar-button${flashClass(pushFlash)}`}
        disabled={!canSubmit}
        onClick={submit}
        title={pushError || undefined}
      >
        {pending ? 'Working…' : 'Add, Commit, Push'}
      </button>
      <button
        className={`actionbar-button${flashClass(syncFlash)}`}
        disabled={!canSync}
        onClick={syncDefault}
        title={
          syncError ||
          (onDefault
            ? 'Fast-forward the default branch from its remote'
            : "Fetch and check out the remote's default branch")
        }
      >
        {syncing ? 'Syncing…' : 'Sync Default'}
      </button>
      <button
        className={`actionbar-button${flashClass(updateFlash)}`}
        disabled={!canUpdate}
        onClick={updateFromDefault}
        title={
          updateError ||
          (onDefault
            ? 'Already on the default branch'
            : "Merge the remote's default branch into the current branch")
        }
      >
        {updating ? 'Updating…' : 'Update from Default'}
      </button>
      <div className="actionbar-right">
        <WorkflowSelect key={`workflow-${cwd ?? 'none'}`} cwd={cwd} />
        <BranchSelect key={cwd ?? 'none'} cwd={cwd} />
      </div>
      {failure && <FailureDialog failure={failure} onDismiss={() => setFailure(null)} />}
    </div>
  )
}

export default ActionBar
