import { useEffect, useState } from 'react'
import BranchSelect from './BranchSelect'
import { flashClass, useFlash } from '@renderer/useFlash'

interface ActionBarProps {
  cwd?: string
}

function ActionBar({ cwd }: ActionBarProps): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [isRepo, setIsRepo] = useState(false)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [pushFlash, flashPush] = useFlash()
  const [syncFlash, flashSync] = useFlash()
  const [pushError, setPushError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false

    const check = async (): Promise<void> => {
      const repo = cwd ? await window.api.git.isRepo(cwd) : false
      if (cancelled) return
      setIsRepo(repo)
      if (!repo) {
        setReady(false)
        return
      }
      try {
        const gitStatus = await window.api.git.status(cwd)
        if (!cancelled) setReady(gitStatus.stageable > 0)
      } catch {
        if (!cancelled) setReady(false)
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

  const busy = pending || syncing
  const canSubmit = ready && !busy && message.trim() !== ''

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
    if (!isRepo || busy) return
    setSyncing(true)
    const result = await window.api.git.syncDefault(cwd)
    setSyncing(false)
    setRefreshKey((key) => key + 1)
    if (result.ok) {
      setSyncError('')
      flashSync('ok')
    } else {
      setSyncError(result.error ?? 'git command failed')
      flashSync('error')
    }
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
        disabled={!isRepo || busy}
        onClick={syncDefault}
        title={syncError || "Fetch and check out the remote's default branch"}
      >
        {syncing ? 'Syncing…' : 'Sync Default'}
      </button>
      <BranchSelect key={cwd ?? 'none'} cwd={cwd} />
    </div>
  )
}

export default ActionBar
