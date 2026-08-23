import { useEffect, useLayoutEffect, useRef, useState } from 'react'

interface Step {
  title: string
  body: string
  selectors: string[]
}

const steps: Step[] = [
  {
    title: 'New tabs',
    body: 'The + opens a fresh terminal session. The globe opens an in-app browser tab beside it.',
    selectors: ['.tab-add', '.tab-browser']
  },
  {
    title: 'Repo tab groups',
    body: 'Tabs are grouped and colored by the repo they belong to, so a linked worktree sits next to the session it came from instead of scattered across the strip.',
    selectors: ['.tab-group']
  },
  {
    title: 'Command buttons',
    body: 'Add a shell-command button for this folder. Click it to run something like `npm run dev`, click again to stop it.',
    selectors: ['.tab-command-add']
  },
  {
    title: 'Changed files',
    body: 'This counts the files you have changed. Click it to list them, then click any file to open its diff.',
    selectors: ['.git-dirty', '.git-header']
  },
  {
    title: 'Working tree diff',
    body: 'Click the branch name to review every uncommitted change together as one diff. Right-click it to open that diff in a split beside the current session instead of a new tab.',
    selectors: ['.git-header-link', '.git-branch']
  },
  {
    title: 'Commit diff',
    body: "Each dot on the graph is a commit. Click one to open that commit's full diff in a tab, or right-click to open it in a split beside the current session.",
    selectors: ['.git-node', '.git-log']
  },
  {
    title: 'Git actions',
    body: 'Commit + push, sync, update from the default branch, open a pull request, and freeze the view - all live here.',
    selectors: ['.actionbar']
  },
  {
    title: 'Branches',
    body: 'Switch, search, and create branches here.',
    selectors: ['.picker-branch']
  },
  {
    title: 'Workspaces',
    body: 'Register a branch as a workspace and snow parks its uncommitted work when you switch away, then restores it when you return. Branching off a dirty workspace asks whether to carry your changes along or park them behind.',
    selectors: ['.picker-workflow']
  },
  {
    title: 'Workspace manager',
    body: 'Lists every registered workspace across every repo. Open one in its own git worktree, or open them all with their matching preset startup commands. Start an additional agent explicitly; its dispatcher remains responsible for tasks.',
    selectors: ['.tab-workflows']
  }
]

interface Box {
  top: number
  left: number
  width: number
  height: number
}

function resolveTarget(selectors: string[]): Element | null {
  for (const selector of selectors) {
    const el = document.querySelector(selector)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    return el
  }
  return null
}

function boxOf(el: Element): Box | null {
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

interface TourProps {
  onClose: () => void
}

function Tour({ onClose }: TourProps): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const [size, setSize] = useState({ w: 320, h: 160 })
  const cardRef = useRef<HTMLDivElement>(null)
  const step = steps[index]
  const last = index === steps.length - 1

  useEffect(() => {
    let frame = 0
    let target: Element | null = null
    const tick = (): void => {
      if (!target || !target.isConnected) target = resolveTarget(step.selectors)
      const next = target ? boxOf(target) : null
      setBox((prev) => {
        if (
          prev &&
          next &&
          prev.top === next.top &&
          prev.left === next.left &&
          prev.width === next.width &&
          prev.height === next.height
        )
          return prev
        return next
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [step])

  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el) return
    const measure = (): void => setSize({ w: el.offsetWidth, h: el.offsetHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [index])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' || e.key === 'Enter')
        setIndex((i) => Math.min(i + 1, steps.length - 1))
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const pad = 6
  const gap = 14
  const vw = window.innerWidth
  const vh = window.innerHeight

  let cardTop: number
  let cardLeft: number
  if (box) {
    const below = box.top + box.height + pad + gap
    const above = box.top - pad - gap - size.h
    cardTop = below + size.h <= vh ? below : above >= 8 ? above : Math.max(8, vh - size.h - 8)
    const center = box.left + box.width / 2
    cardLeft = Math.min(Math.max(center - size.w / 2, 8), vw - size.w - 8)
  } else {
    cardTop = vh / 2 - size.h / 2
    cardLeft = vw / 2 - size.w / 2
  }

  return (
    <div className="tour">
      <div className="tour-backdrop" />
      {box && (
        <div
          className="tour-spotlight"
          style={{
            top: box.top - pad,
            left: box.left - pad,
            width: box.width + pad * 2,
            height: box.height + pad * 2
          }}
        />
      )}
      <div className="tour-card" ref={cardRef} style={{ top: cardTop, left: cardLeft }}>
        <div className="tour-card-step">
          {index + 1} / {steps.length}
        </div>
        <div className="tour-card-title">{step.title}</div>
        <div className="tour-card-body">{step.body}</div>
        <div className="tour-card-actions">
          <button className="tour-skip" onClick={onClose}>
            Skip tour
          </button>
          <div className="tour-nav">
            {index > 0 && (
              <button className="tour-button" onClick={() => setIndex((i) => i - 1)}>
                Back
              </button>
            )}
            {last ? (
              <button className="tour-button tour-button-primary" onClick={onClose}>
                Done
              </button>
            ) : (
              <button
                className="tour-button tour-button-primary"
                onClick={() => setIndex((i) => i + 1)}
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Tour
