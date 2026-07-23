import { useEffect, useState } from 'react'

interface ActionBarProps {
  cwd?: string
}

interface ActionStatus {
  ok: boolean
  text: string
}

function ActionBar({ cwd }: ActionBarProps): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<ActionStatus | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false

    const check = async (): Promise<void> => {
      const repo = cwd ? await window.api.git.isRepo(cwd) : false
      if (!repo) {
        if (!cancelled) setReady(false)
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

  const canSubmit = ready && !pending && message.trim() !== ''

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setPending(true)
    setStatus(null)
    const result = await window.api.git.commitPush(cwd, message.trim())
    setPending(false)
    setRefreshKey((key) => key + 1)
    if (result.ok) {
      setMessage('')
      setStatus({ ok: true, text: 'Pushed' })
    } else {
      setStatus({ ok: false, text: result.error ?? 'git command failed' })
    }
  }

  return (
    <div className="actionbar">
      <input
        className="actionbar-input"
        placeholder="Commit message"
        value={message}
        disabled={!ready || pending}
        onChange={(e) => {
          setMessage(e.target.value)
          setStatus(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button className="actionbar-button" disabled={!canSubmit} onClick={submit}>
        {pending ? 'Working…' : 'Add, Commit, Push'}
      </button>
      {status && (
        <span
          className={status.ok ? 'actionbar-status' : 'actionbar-status actionbar-status-error'}
        >
          {status.text}
        </span>
      )}
    </div>
  )
}

export default ActionBar
