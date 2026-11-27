import { useCallback, useEffect, useRef, useState } from 'react'
import {
  changedDirs,
  childPath,
  collapseDir,
  fileTarget,
  matchParts,
  searchTree,
  treeRoot,
  type SearchHit,
  type SearchNode
} from '@renderer/appModel'
import { basename } from '@renderer/format'

type DirEntry = { name: string; dir: boolean; ignored: boolean }
type Listing =
  { entries: DirEntry[]; repo: { root: string; prefix: string } | null } | { error: string }
type SearchResult = { hits: SearchHit[]; total: number; partial: boolean } | { error: string }
type Search = { root: string; query: string; result: SearchResult; nodes: SearchNode[] }

export interface FileTreeProps {
  cwd?: string
  onOpenFile?: (target: { root: string; path: string }) => void
}

const indentPx = 12
const searchDebounceMs = 150

function Highlighted({ name, query }: { name: string; query: string }): React.JSX.Element {
  return (
    <span className="file-tree-name">
      {matchParts(name, query).map((part, i) =>
        part.match ? (
          <mark key={i} className="file-tree-match">
            {part.text}
          </mark>
        ) : (
          part.text
        )
      )}
    </span>
  )
}

function moveFocus(container: HTMLElement | null, from: Element | null, delta: number): boolean {
  if (!container) return false
  const rows = [...container.querySelectorAll<HTMLButtonElement>('.file-tree-row:not(:disabled)')]
  const index = from ? rows.indexOf(from as HTMLButtonElement) : -1
  const target = rows[index === -1 ? (delta > 0 ? 0 : rows.length - 1) : index + delta]
  target?.focus()
  return Boolean(target)
}

function FileTreeRoot({
  hidden,
  root,
  onOpenFile
}: Omit<FileTreeProps, 'cwd'> & { hidden: boolean; root: string }): React.JSX.Element {
  const [listings, setListings] = useState<Record<string, Listing>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const expandedRef = useRef(expanded)
  const watchedRef = useRef<ReadonlySet<string>>(new Set())
  const loadSeqRef = useRef(new Map<string, number>())
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<Search | null>(null)
  const [collapsedHits, setCollapsedHits] = useState<ReadonlySet<string>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const needle = query.trim()

  const load = useCallback((dir: string): void => {
    const seq = (loadSeqRef.current.get(dir) ?? 0) + 1
    loadSeqRef.current.set(dir, seq)
    window.api.files
      .list(dir)
      .catch((error: unknown) => ({ error: String(error) }))
      .then((listing) => {
        if (loadSeqRef.current.get(dir) !== seq) return
        setListings((prev) => ({ ...prev, [dir]: listing }))
      })
  }, [])

  const refresh = useCallback((): void => {
    load(root)
    expandedRef.current.forEach(load)
  }, [load, root])

  useEffect(() => {
    if (!hidden) refresh()
  }, [hidden, refresh])

  useEffect(
    () =>
      window.api.files.onChanged((dir, names) => {
        if (dir !== root && !expandedRef.current.has(dir)) return
        for (const path of changedDirs(expandedRef.current, dir, names))
          if (path === root || expandedRef.current.has(path)) load(path)
      }),
    [load, root]
  )

  useEffect(() => {
    const next = new Set(hidden ? [] : [root, ...expanded])
    const prev = watchedRef.current
    for (const dir of next) if (!prev.has(dir)) window.api.files.watch(dir)
    for (const dir of prev) if (!next.has(dir)) window.api.files.unwatch(dir)
    watchedRef.current = next
  }, [hidden, root, expanded])

  useEffect(
    () => () => {
      for (const dir of watchedRef.current) window.api.files.unwatch(dir)
      watchedRef.current = new Set()
    },
    []
  )

  useEffect(() => {
    if (!needle || hidden) return
    let cancelled = false
    const timer = setTimeout(() => {
      window.api.files
        .search(root, needle)
        .catch((error: unknown): SearchResult => ({ error: String(error) }))
        .then((result) => {
          if (cancelled) return
          const nodes = 'error' in result ? [] : searchTree(result.hits)
          setSearch({ root, query: needle, result, nodes })
          setCollapsedHits(new Set())
        })
    }, searchDebounceMs)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [needle, root, hidden])

  const toggle = (dir: string): void => {
    const opening = !expanded.has(dir)
    const next = opening ? new Set(expanded).add(dir) : collapseDir(expanded, dir)
    if (opening) load(dir)
    expandedRef.current = next
    setExpanded(next)
  }

  const reveal = (path: string): void => {
    const dirs: string[] = []
    for (const name of path.split('/')) dirs.push(childPath(dirs.at(-1) ?? root, name))
    dirs.forEach(load)
    const next = new Set([...expanded, ...dirs])
    expandedRef.current = next
    setExpanded(next)
    setQuery('')
  }

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && query) {
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
    } else if (e.key === 'ArrowDown' && moveFocus(bodyRef.current, null, 1)) e.preventDefault()
  }

  const onBodyKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const delta = e.key === 'ArrowDown' ? 1 : -1
    if (!moveFocus(bodyRef.current, document.activeElement, delta) && delta < 0)
      inputRef.current?.focus()
  }

  const rows = (dir: string, depth: number): React.ReactNode => {
    const listing = listings[dir]
    const padding = { paddingLeft: 8 + depth * indentPx }
    if (!listing)
      return (
        <div className="file-tree-note" style={padding}>
          Loading…
        </div>
      )
    if ('error' in listing)
      return (
        <div className="file-tree-note" style={padding} title={listing.error}>
          Cannot read this folder
        </div>
      )
    if (listing.entries.length === 0 && depth > 0)
      return (
        <div className="file-tree-note" style={padding}>
          Empty
        </div>
      )
    return listing.entries.map((entry) => {
      const path = childPath(dir, entry.name)
      const muted = entry.ignored ? ' file-tree-ignored' : ''
      if (entry.dir) {
        const open = expanded.has(path)
        return (
          <div key={path} role="treeitem" aria-expanded={open}>
            <button
              className={`file-tree-row${muted}`}
              style={padding}
              title={path}
              onClick={() => toggle(path)}
            >
              <span className="file-tree-chevron">{open ? '\u{f107}' : '\u{f105}'}</span>
              <span className="file-tree-icon file-tree-folder">
                {open ? '\u{f07c}' : '\u{f07b}'}
              </span>
              <span className="file-tree-name">{entry.name}</span>
            </button>
            {open && <div role="group">{rows(path, depth + 1)}</div>}
          </div>
        )
      }
      const target = fileTarget(listing.repo, entry.name)
      return (
        <button
          key={path}
          role="treeitem"
          className={`file-tree-row${muted}`}
          style={padding}
          disabled={!target || !onOpenFile}
          title={target ? path : `${path}\nNot inside a git repository`}
          onClick={() => target && onOpenFile?.(target)}
        >
          <span className="file-tree-chevron" />
          <span className="file-tree-icon">{'\u{f15b}'}</span>
          <span className="file-tree-name">{entry.name}</span>
        </button>
      )
    })
  }

  const toggleHit = (path: string): void =>
    setCollapsedHits((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const hitRows = (nodes: SearchNode[], depth: number, highlight: string): React.ReactNode =>
    nodes.map((node) => {
      const path = childPath(root, node.path)
      const padding = { paddingLeft: 8 + depth * indentPx }
      const name = node.match ? (
        <Highlighted name={node.name} query={highlight} />
      ) : (
        <span className="file-tree-name">{node.name}</span>
      )
      if (node.dir) {
        const leaf = node.children.length === 0
        const open = !leaf && !collapsedHits.has(node.path)
        return (
          <div key={node.path} role="treeitem" aria-expanded={open}>
            <button
              className="file-tree-row"
              style={padding}
              title={leaf ? `${path}\nShow in tree` : path}
              onClick={() => (leaf ? reveal(node.path) : toggleHit(node.path))}
            >
              <span className="file-tree-chevron">
                {leaf ? '' : open ? '\u{f107}' : '\u{f105}'}
              </span>
              <span className="file-tree-icon file-tree-folder">
                {open ? '\u{f07c}' : '\u{f07b}'}
              </span>
              {name}
            </button>
            {open && <div role="group">{hitRows(node.children, depth + 1, highlight)}</div>}
          </div>
        )
      }
      const target = node.target
      return (
        <button
          key={node.path}
          role="treeitem"
          className="file-tree-row"
          style={padding}
          disabled={!target || !onOpenFile}
          title={target ? path : `${path}\nNot inside a git repository`}
          onClick={() => target && onOpenFile?.(target)}
        >
          <span className="file-tree-chevron" />
          <span className="file-tree-icon">{'\u{f15b}'}</span>
          {name}
        </button>
      )
    })

  const searchBody = (): React.ReactNode => {
    if (!search || search.query !== needle || search.root !== root)
      return <div className="file-tree-note file-tree-status">Searching…</div>
    const { result } = search
    if ('error' in result)
      return (
        <div className="file-tree-note file-tree-status" title={result.error}>
          Search failed
        </div>
      )
    if (result.total === 0)
      return <div className="file-tree-note file-tree-status">No matches for “{search.query}”</div>
    const shown = result.hits.length
    const summary =
      shown < result.total
        ? `Showing ${shown} of ${result.total} matches`
        : `${result.total} ${result.total === 1 ? 'match' : 'matches'}`
    return (
      <>
        <div className="file-tree-note file-tree-status">
          {summary}
          {result.partial && ' · folder too large, results incomplete'}
        </div>
        {hitRows(search.nodes, 0, search.query)}
      </>
    )
  }

  return (
    <div className="file-tree" style={hidden ? { display: 'none' } : undefined}>
      <div className="file-tree-header">
        <span className="file-tree-root" title={root}>
          {basename(root)}
        </span>
      </div>
      <div className="file-tree-search">
        <span className="file-tree-search-icon">{'\u{f002}'}</span>
        <input
          ref={inputRef}
          className="file-tree-search-input"
          placeholder="Search files"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
        />
        {query && (
          <button
            className="file-tree-search-clear"
            title="Clear search (Esc)"
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            {'\u{f00d}'}
          </button>
        )}
      </div>
      <div className="file-tree-body" role="tree" ref={bodyRef} onKeyDown={onBodyKey}>
        {needle ? searchBody() : rows(root, 0)}
      </div>
    </div>
  )
}

function FileTree({ hidden, cwd, ...rest }: FileTreeProps & { hidden: boolean }): React.ReactNode {
  if (!cwd) return hidden ? null : <div className="git-empty">No current directory</div>
  const root = treeRoot(cwd)
  return <FileTreeRoot key={root} hidden={hidden} root={root} {...rest} />
}

export default FileTree
