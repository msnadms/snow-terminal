import { useCallback, useEffect, useRef, useState } from 'react'

const ALL = 'snow-find'
const CURRENT = 'snow-find-current'
const TOOLS = 'commit-tools'
const GUTTER = 'diff-gutter'
const MAX_MATCHES = 2000
const REVEAL_MARGIN = 60

const blockTags = new Set(['TD', 'TH', 'TR', 'DIV', 'PRE', 'P', 'LI', 'BUTTON'])

interface Piece {
  node: Text
  start: number
}

function blockOf(node: Node, root: HTMLElement): Node | null {
  if (node.parentElement?.classList.contains(GUTTER)) return null
  let block: Node | null = null
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (el.classList.contains(TOOLS)) return null
    if (!block && blockTags.has(el.tagName)) block = el
  }
  return block ?? root
}

function scan(root: HTMLElement): { text: string; pieces: Piece[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const pieces: Piece[] = []
  let text = ''
  let block: Node | null = null

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue
    if (!value) continue
    const owner = blockOf(node, root)
    if (!owner) continue
    if (block && owner !== block) text += '\n'
    block = owner
    pieces.push({ node: node as Text, start: text.length })
    text += value
  }

  return { text, pieces }
}

function pieceAt(pieces: Piece[], offset: number): Piece {
  let lo = 0
  let hi = pieces.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pieces[mid].start <= offset) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return pieces[found]
}

function rangeAt(pieces: Piece[], from: number, to: number): Range {
  const start = pieceAt(pieces, from)
  const end = pieceAt(pieces, to - 1)
  const range = document.createRange()
  range.setStart(start.node, from - start.start)
  range.setEnd(end.node, to - end.start)
  return range
}

function findRanges(root: HTMLElement, query: string): { ranges: Range[]; capped: boolean } {
  const { text, pieces } = scan(root)
  if (pieces.length === 0) return { ranges: [], capped: false }

  const lower = text.toLowerCase()
  const folded = lower.length === text.length
  const haystack = folded ? lower : text
  const needle = folded ? query.toLowerCase() : query

  const ranges: Range[] = []
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    if (ranges.length === MAX_MATCHES) return { ranges, capped: true }
    ranges.push(rangeAt(pieces, at, at + needle.length))
    at = haystack.indexOf(needle, at + needle.length)
  }
  return { ranges, capped: false }
}

function reveal(host: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect()
  const view = host.getBoundingClientRect()
  if (rect.top >= view.top + REVEAL_MARGIN && rect.bottom <= view.bottom - REVEAL_MARGIN) return
  host.scrollTop += rect.top - view.top - view.height / 3
}

function inTools(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return el?.closest(`.${TOOLS}`) != null
}

let owner: object | null = null

function highlight(id: object, all: Range[], current: Range | undefined): void {
  owner = id
  CSS.highlights.set(ALL, new Highlight(...all))
  if (current) CSS.highlights.set(CURRENT, new Highlight(current))
  else CSS.highlights.delete(CURRENT)
}

function unhighlight(id: object): void {
  if (owner !== id) return
  owner = null
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

export interface Find {
  open: boolean
  query: string
  count: number
  index: number
  capped: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  setQuery: (value: string) => void
  step: (delta: number) => void
  close: () => void
}

export function useFind(hostRef: React.RefObject<HTMLDivElement | null>, active: boolean): Find {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [index, setIndex] = useState(0)
  const [capped, setCapped] = useState(false)
  const ranges = useRef<Range[]>([])
  const indexRef = useRef(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const id = useRef({})

  const paint = useCallback(
    (next: number) => {
      const list = ranges.current
      indexRef.current = next
      setIndex(next)
      const current = list[next]
      highlight(id.current, list, current)
      const host = hostRef.current
      if (current && host) reveal(host, current)
    },
    [hostRef]
  )

  const search = useCallback(
    (keep: boolean) => {
      const host = hostRef.current
      if (!host || !active || !open || !query) {
        ranges.current = []
        unhighlight(id.current)
        setCount(0)
        setCapped(false)
        return
      }
      const result = findRanges(host, query)
      ranges.current = result.ranges
      setCount(result.ranges.length)
      setCapped(result.capped)
      paint(keep ? Math.min(indexRef.current, Math.max(result.ranges.length - 1, 0)) : 0)
    },
    [hostRef, active, open, query, paint]
  )

  useEffect(() => {
    search(false)
  }, [search])

  useEffect(() => {
    const self = id.current
    return () => unhighlight(self)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !active || !open || !query) return
    let timer: number | undefined
    const observer = new MutationObserver((records) => {
      if (records.every((record) => inTools(record.target))) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => search(true), 120)
    })
    observer.observe(host, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [hostRef, active, open, query, search])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  const step = useCallback(
    (delta: number) => {
      const total = ranges.current.length
      if (total === 0) return
      paint((indexRef.current + delta + total) % total)
    },
    [paint]
  )

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setOpen(true)
        requestAnimationFrame(() => inputRef.current?.select())
        return
      }
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, open, close])

  return { open, query, count, index, capped, inputRef, setQuery, step, close }
}
