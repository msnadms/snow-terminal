import { useEffect, useRef, useState } from 'react'
import FailureDialog from './FailureDialog'
import { failureOf, type Failure } from '@renderer/format'
import { flashClass, useFlash } from '@renderer/useFlash'

interface BranchSelectProps {
  cwd?: string
}

type BranchTab = 'local' | 'origin'

function BranchSelect({ cwd }: BranchSelectProps): React.JSX.Element | null {
  const [current, setCurrent] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [remotes, setRemotes] = useState<string[]>([])
  const [tab, setTab] = useState<BranchTab>('local')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [flash, trigger] = useFlash()
  const [newName, setNewName] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [choice, setChoice] = useState<{ name: string; branch: string; files: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      if (!cwd) return
      const result = await window.api.git.branches(cwd)
      if (cancelled) return
      setCurrent(result.current)
      setBranches(result.branches)
      setRemotes(result.remotes)
    }

    load()
    const offChanged = window.api.git.onChanged(() => load())

    return () => {
      cancelled = true
      offChanged()
    }
  }, [cwd])

  useEffect(() => {
    if (!open) return

    searchRef.current?.focus()

    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!choice) return

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setChoice(null)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [choice])

  if (!current) return null

  const toggle = (): void => {
    setQuery('')
    setOpen((prev) => !prev)
  }

  const finish = (
    result: { ok: boolean; branch?: string; error?: string; detail?: string },
    branch: string
  ): void => {
    setPending(false)
    if (result.ok || result.branch) {
      const name = result.branch ?? branch
      setCurrent(name)
      setBranches((prev) => (prev.includes(name) ? prev : [...prev, name].sort()))
    }
    if (!result.ok) {
      const next = failureOf(result)
      setError(next.title)
      setFailure(next)
      trigger('error')
      return
    }
    setError('')
    trigger('ok')
  }

  const switchTo = async (branch: string, create: boolean, carry = false): Promise<void> => {
    setOpen(false)
    setPending(true)
    setError('')
    const result = create
      ? await window.api.git.createBranch(cwd, branch, carry)
      : await window.api.git.checkout(cwd, branch)
    finish(result, branch)
  }

  const checkout = (branch: string): void => {
    if (branch === current || pending) return
    switchTo(branch, false)
  }

  const checkoutRemote = async (ref: string): Promise<void> => {
    if (pending) return
    setOpen(false)
    setPending(true)
    setError('')
    const result = await window.api.git.checkoutRemote(cwd, ref)
    finish(result, ref)
  }

  const createBranch = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const name = newName.trim()
    if (!name || pending) return
    setNewName('')
    const preview = await window.api.git.parkPreview(cwd)
    if (!preview) {
      switchTo(name, true)
      return
    }
    setOpen(false)
    setChoice({ name, ...preview })
  }

  const needle = query.trim().toLowerCase()
  const source = tab === 'local' ? branches : remotes
  const visible = needle ? source.filter((name) => name.toLowerCase().includes(needle)) : source

  return (
    <div className="picker-select" ref={rootRef}>
      <button
        className={`picker-button${flashClass(flash)}`}
        disabled={pending}
        onClick={toggle}
        title={error || current}
      >
        <span className="picker-icon">{''}</span>
        <span className="picker-name">{pending ? 'Switching…' : current}</span>
        <span className="picker-caret">▾</span>
      </button>
      {open && (
        <div className="picker-menu">
          <div className="picker-tabs">
            <button
              className={`picker-tab${tab === 'local' ? ' picker-tab-active' : ''}`}
              onClick={() => setTab('local')}
            >
              Local
            </button>
            <button
              className={`picker-tab${tab === 'origin' ? ' picker-tab-active' : ''}`}
              onClick={() => setTab('origin')}
            >
              Origin
            </button>
          </div>
          <input
            ref={searchRef}
            className="picker-search"
            placeholder="Search branches…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="picker-list">
            {visible.length === 0 && <div className="picker-none">No branches</div>}
            {visible.map((branch) => (
              <button
                key={branch}
                className={`picker-item${branch === current ? ' picker-item-current' : ''}`}
                onClick={() => (tab === 'local' ? checkout(branch) : checkoutRemote(branch))}
              >
                {branch}
              </button>
            ))}
          </div>
          {tab === 'local' && (
            <form className="picker-create" onSubmit={createBranch}>
              <input
                className="picker-create-input"
                placeholder="New branch…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button className="picker-create-button" type="submit" disabled={!newName.trim()}>
                +
              </button>
            </form>
          )}
        </div>
      )}
      {choice && (
        <div className="git-dialog-backdrop" onPointerDown={() => setChoice(null)}>
          <div className="git-dialog" onPointerDown={(e) => e.stopPropagation()}>
            <div className="git-dialog-title">Where do your changes go?</div>
            <pre className="git-dialog-detail">
              {[
                `You have ${choice.files} uncommitted file${choice.files === 1 ? '' : 's'} on ${choice.branch}, a registered workflow.`,
                '',
                `Park them: they stay with ${choice.branch} and ${choice.name} starts clean.`,
                `Bring them: ${choice.name} starts with the changes, as git checkout -b would.`
              ].join('\n')}
            </pre>
            <div className="git-dialog-actions">
              <button
                className="git-dialog-button"
                onClick={() => {
                  setChoice(null)
                  switchTo(choice.name, true, false)
                }}
              >
                Park on {choice.branch}
              </button>
              <button
                className="git-dialog-button"
                onClick={() => {
                  setChoice(null)
                  switchTo(choice.name, true, true)
                }}
              >
                Bring to {choice.name}
              </button>
            </div>
          </div>
        </div>
      )}
      {failure && <FailureDialog failure={failure} onDismiss={() => setFailure(null)} />}
    </div>
  )
}

export default BranchSelect
