import { useCallback, useEffect, useRef, useState } from 'react'
import { changedDirs, childPath, collapseDir, fileTarget, treeRoot } from '@renderer/appModel'
import { basename } from '@renderer/format'

type DirEntry = { name: string; dir: boolean; ignored: boolean }
type Listing =
  { entries: DirEntry[]; repo: { root: string; prefix: string } | null } | { error: string }

export interface FileTreeProps {
  cwd?: string
  onOpenFile?: (target: { root: string; path: string }) => void
}

const indentPx = 12

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

  const toggle = (dir: string): void => {
    const opening = !expanded.has(dir)
    const next = opening ? new Set(expanded).add(dir) : collapseDir(expanded, dir)
    if (opening) load(dir)
    expandedRef.current = next
    setExpanded(next)
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

  return (
    <div className="file-tree" style={hidden ? { display: 'none' } : undefined}>
      <div className="file-tree-header">
        <span className="file-tree-root" title={root}>
          {basename(root)}
        </span>
        <button className="file-tree-refresh" title="Refresh" onClick={refresh}>
          {'\u{f021}'}
        </button>
      </div>
      <div className="file-tree-body" role="tree">
        {rows(root, 0)}
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
