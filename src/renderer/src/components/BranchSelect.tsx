import { useEffect, useRef, useState } from 'react'
import { flashClass, useFlash } from '@renderer/useFlash'

interface BranchSelectProps {
  cwd?: string
}

function BranchSelect({ cwd }: BranchSelectProps): React.JSX.Element | null {
  const [current, setCurrent] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [flash, trigger] = useFlash()
  const [newName, setNewName] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      if (!cwd) return
      const result = await window.api.git.branches(cwd)
      if (cancelled) return
      setCurrent(result.current)
      setBranches(result.branches)
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

  const switchTo = async (branch: string, create: boolean): Promise<void> => {
    setOpen(false)
    setPending(true)
    setError('')
    const result = create
      ? await window.api.git.createBranch(cwd, branch)
      : await window.api.git.checkout(cwd, branch)
    setPending(false)
    if (!result.ok) {
      setError(result.error ?? 'git command failed')
      trigger('error')
      return
    }
    setError('')
    trigger('ok')
    setCurrent(branch)
    setBranches((prev) => (prev.includes(branch) ? prev : [...prev, branch].sort()))
  }

  const checkout = (branch: string): void => {
    if (branch === current || pending) return
    switchTo(branch, false)
  }

  const createBranch = (e: React.FormEvent): void => {
    e.preventDefault()
    const name = newName.trim()
    if (!name || pending) return
    setNewName('')
    switchTo(name, true)
  }

  return (
    <div className="branch-select" ref={rootRef}>
      <button
        className={`branch-button${flashClass(flash)}`}
        disabled={pending}
        onClick={() => setOpen((prev) => !prev)}
        title={error || current}
      >
        <span className="branch-name">{pending ? 'Switching…' : current}</span>
        <span className="branch-caret">▾</span>
      </button>
      {open && (
        <div className="branch-menu">
          <div className="branch-list">
            {branches.map((branch) => (
              <button
                key={branch}
                className={`branch-item${branch === current ? ' branch-item-current' : ''}`}
                onClick={() => checkout(branch)}
              >
                {branch}
              </button>
            ))}
          </div>
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
        </div>
      )}
    </div>
  )
}

export default BranchSelect
