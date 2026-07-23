import { useEffect, useRef, useState } from 'react'
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

  if (!current) return null

  const toggle = (): void => {
    setQuery('')
    setOpen((prev) => !prev)
  }

  const finish = (
    result: { ok: boolean; branch?: string; error?: string },
    branch: string
  ): void => {
    setPending(false)
    if (!result.ok) {
      setError(result.error ?? 'git command failed')
      trigger('error')
      return
    }
    setError('')
    trigger('ok')
    const name = result.branch ?? branch
    setCurrent(name)
    setBranches((prev) => (prev.includes(name) ? prev : [...prev, name].sort()))
  }

  const switchTo = async (branch: string, create: boolean): Promise<void> => {
    setOpen(false)
    setPending(true)
    setError('')
    const result = create
      ? await window.api.git.createBranch(cwd, branch)
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

  const createBranch = (e: React.FormEvent): void => {
    e.preventDefault()
    const name = newName.trim()
    if (!name || pending) return
    setNewName('')
    switchTo(name, true)
  }

  const needle = query.trim().toLowerCase()
  const source = tab === 'local' ? branches : remotes
  const visible = needle ? source.filter((name) => name.toLowerCase().includes(needle)) : source

  return (
    <div className="branch-select" ref={rootRef}>
      <button
        className={`branch-button${flashClass(flash)}`}
        disabled={pending}
        onClick={toggle}
        title={error || current}
      >
        <span className="branch-name">{pending ? 'Switching…' : current}</span>
        <span className="branch-caret">▾</span>
      </button>
      {open && (
        <div className="branch-menu">
          <div className="branch-tabs">
            <button
              className={`branch-tab${tab === 'local' ? ' branch-tab-active' : ''}`}
              onClick={() => setTab('local')}
            >
              Local
            </button>
            <button
              className={`branch-tab${tab === 'origin' ? ' branch-tab-active' : ''}`}
              onClick={() => setTab('origin')}
            >
              Origin
            </button>
          </div>
          <input
            ref={searchRef}
            className="branch-search"
            placeholder="Search branches…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="branch-list">
            {visible.length === 0 && <div className="branch-none">No branches</div>}
            {visible.map((branch) => (
              <button
                key={branch}
                className={`branch-item${branch === current ? ' branch-item-current' : ''}`}
                onClick={() => (tab === 'local' ? checkout(branch) : checkoutRemote(branch))}
              >
                {branch}
              </button>
            ))}
          </div>
          {tab === 'local' && (
            <form className="branch-create" onSubmit={createBranch}>
              <input
                className="branch-create-input"
                placeholder="New branch…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button className="branch-create-button" type="submit" disabled={!newName.trim()}>
                +
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  )
}

export default BranchSelect
