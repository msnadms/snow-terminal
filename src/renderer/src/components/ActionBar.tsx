import { useEffect, useState } from 'react'

interface ActionBarProps {
  cwd?: string
}

interface ActionStatus {
  ok: boolean
  text: string
}

function ActionBar({ cwd }: ActionBarProps): React.JSX.Element {
  const [isRepo, setIsRepo] = useState(false)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<ActionStatus | null>(null)

  useEffect(() => {
    let cancelled = false

    const check = async (): Promise<void> => {
      const repo = cwd ? await window.api.git.isRepo(cwd) : false
      if (!cancelled) setIsRepo(repo)
    }

    check()
    const offChanged = window.api.git.onChanged(() => check())

    return () => {
      cancelled = true
      offChanged()
    }
  }, [cwd])

  const canSubmit = isRepo && !pending && message.trim() !== ''

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setPending(true)
    setStatus(null)
    const result = await window.api.git.commitPush(cwd, message.trim())
    setPending(false)
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
        disabled={!isRepo || pending}
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
