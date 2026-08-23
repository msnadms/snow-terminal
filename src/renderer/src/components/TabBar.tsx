import { Fragment, memo, useMemo, useState } from 'react'
import ContextMenu from './ContextMenu'
import { repoColor } from '@renderer/repoColor'
import { slotAllowed } from '@renderer/tabGroups'
import { useGitColors } from '@renderer/useGitColors'
import type { CommandItem, SessionStatus } from '../App'
import type { Preset } from '../useSnowconfig'

type TabSession = { id: number; group: string | null; preset?: Preset }

interface TabBarProps {
  sessions: TabSession[]
  activeId: number | 'home' | 'workflows'
  labels: Record<number, string>
  statuses: Record<number, SessionStatus>
  commands: CommandItem[]
  running: Record<string, number>
  presets: Preset[]
  onSelect: (id: number | 'home' | 'workflows') => void
  onClose: (id: number) => void
  onCloseGroup: (ids: number[]) => void
  onAddGroup: (preset: Preset) => void
  onReorder: (from: number, to: number) => void
  onAdd: () => void
  onOpenBrowser: () => void
  onOpenWorkflows: () => void
  onSplit: () => void
  onSplitWithPreset: (preset: Preset) => void
  onToggleCommand: (item: CommandItem) => void
  onAddCommand?: (command: string) => void
  onRemoveCommand: (item: CommandItem) => void
  canSplit: boolean
}

function TabBar({
  sessions,
  activeId,
  labels,
  statuses,
  commands,
  running,
  presets,
  onSelect,
  onClose,
  onCloseGroup,
  onAddGroup,
  onReorder,
  onAdd,
  onOpenBrowser,
  onOpenWorkflows,
  onSplit,
  onSplitWithPreset,
  onToggleCommand,
  onAddCommand,
  onRemoveCommand,
  canSplit
}: TabBarProps): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<{ item: CommandItem; x: number; y: number } | null>(null)
  const [splitMenu, setSplitMenu] = useState<{ x: number; y: number } | null>(null)
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{
    ids: number[]
    preset?: Preset
    x: number
    y: number
  } | null>(null)
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)
  const lanes = useGitColors()?.lanes

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const groups = useMemo(() => sessions.map((session) => session.group), [sessions])

  const insertAt =
    drag &&
    drag.over !== drag.from &&
    drag.over !== drag.from + 1 &&
    slotAllowed(groups, drag.from, drag.over)
      ? drag.over
      : null

  const toggleGroup = (group: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  const [lastActiveId, setLastActiveId] = useState(activeId)
  if (activeId !== lastActiveId) {
    setLastActiveId(activeId)
    const group = sessions.find((s) => s.id === activeId)?.group
    if (group != null && collapsedGroups.has(group)) {
      const next = new Set(collapsedGroups)
      next.delete(group)
      setCollapsedGroups(next)
    }
  }

  type Segment =
    | { kind: 'single'; session: TabSession; index: number }
    | {
        kind: 'group'
        group: string
        items: { session: TabSession; index: number }[]
      }

  const segments = useMemo(() => {
    const result: Segment[] = []
    sessions.forEach((session, index) => {
      const last = result[result.length - 1]
      if (session.group != null && last?.kind === 'group' && last.group === session.group) {
        last.items.push({ session, index })
      } else if (session.group != null) {
        result.push({ kind: 'group', group: session.group, items: [{ session, index }] })
      } else {
        result.push({ kind: 'single', session, index })
      }
    })
    return result
  }, [sessions])

  const renderTab = (session: TabSession, i: number): React.JSX.Element => {
    const { id } = session
    const drop =
      insertAt === i
        ? ' tab-drop-before'
        : insertAt === sessions.length && i === sessions.length - 1
          ? ' tab-drop-after'
          : ''
    return (
      <div
        className={`tab${activeId === id ? ' tab-active' : ''}${drag?.from === i ? ' tab-dragging' : ''}${drop}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', String(id))
          setDrag({ from: i, over: i })
        }}
        onDragOver={(e) => {
          if (!drag) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const rect = e.currentTarget.getBoundingClientRect()
          const over = e.clientX < rect.left + rect.width / 2 ? i : i + 1
          setDrag((d) => (d && d.over !== over ? { ...d, over } : d))
        }}
        onDrop={(e) => {
          e.preventDefault()
          if (drag && insertAt !== null) onReorder(drag.from, insertAt)
          setDrag(null)
        }}
        onDragEnd={() => setDrag(null)}
        onClick={() => onSelect(id)}
      >
        {statuses[id] && statuses[id] !== 'idle' && activeId !== id && (
          <span className={`tab-status tab-status-${statuses[id]}`} />
        )}
        <span className="tab-label">{labels[id] ?? `Session ${id}`}</span>
        <button
          className="tab-close"
          onClick={(e) => {
            e.stopPropagation()
            onClose(id)
          }}
          title="Close session"
        >
          
        </button>
      </div>
    )
  }

  const submit = (): void => {
    const command = draft.trim()
    if (command) onAddCommand?.(command)
    setDraft('')
    setAdding(false)
  }

  const cancel = (): void => {
    setDraft('')
    setAdding(false)
  }

  const removeCommand = (item: CommandItem): void => {
    setMenu(null)
    if (running[item.runKey] != null) onToggleCommand(item)
    onRemoveCommand(item)
  }

  return (
    <div className="tabbar">
      <button
        className={`tab-home${activeId === 'home' ? ' tab-active' : ''}`}
        onClick={() => onSelect('home')}
        title="Home"
      >
        󱎱
      </button>
      <button
        className={`tab-workflows${activeId === 'workflows' ? ' tab-active' : ''}`}
        onClick={onOpenWorkflows}
        title="Workspaces"
      >
        
      </button>
      <div
        className="tab-list"
        onWheel={(e) => {
          if (e.deltaY === 0) return
          e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        {segments.map((seg, si) => {
          const boundaryDivider =
            si > 0 && (seg.kind === 'group' || segments[si - 1].kind === 'group')

          if (seg.kind === 'single') {
            return (
              <Fragment key={seg.session.id}>
                {boundaryDivider && <span className="tab-group-divider" />}
                {renderTab(seg.session, seg.index)}
              </Fragment>
            )
          }

          const color = repoColor(seg.group, lanes)
          const style = { '--tab-group': color } as React.CSSProperties
          const collapsed = collapsedGroups.has(seg.group)
          const ids = seg.items.map((it) => it.session.id)
          const preset = seg.items.find((it) => it.session.preset != null)?.session.preset
          const onGroupContextMenu = (e: React.MouseEvent): void => {
            e.preventDefault()
            setGroupMenu({ ids, preset, x: e.clientX, y: e.clientY })
          }

          if (collapsed) {
            return (
              <Fragment key={seg.group}>
                {boundaryDivider && <span className="tab-group-divider" />}
                <button
                  className="tab-group-collapsed"
                  style={style}
                  onClick={() => toggleGroup(seg.group)}
                  onContextMenu={onGroupContextMenu}
                  title={`${seg.items.length} tabs (click to expand)`}
                />
              </Fragment>
            )
          }

          return (
            <Fragment key={seg.group}>
              {boundaryDivider && <span className="tab-group-divider" />}
              <div className="tab-group" style={style} onContextMenu={onGroupContextMenu}>
                <button
                  className="tab-group-toggle"
                  onClick={() => toggleGroup(seg.group)}
                  title="Collapse group"
                />
                {seg.items.map(({ session, index }, ii) => (
                  <Fragment key={session.id}>
                    {ii > 0 && <span className="tab-group-item-divider" />}
                    {renderTab(session, index)}
                  </Fragment>
                ))}
              </div>
            </Fragment>
          )
        })}
      </div>
      <button
        className="tab-add"
        onClick={onAdd}
        onContextMenu={(e) => {
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          setAddMenu({ x: r.left, y: r.bottom + 4 })
        }}
        title="New session (right-click for more)"
      >
        +
      </button>
      <button
        className="tab-command-add"
        onMouseDown={(e) => {
          if (adding) e.preventDefault()
        }}
        onClick={() => (adding ? submit() : setAdding(true))}
        disabled={!onAddCommand}
        title="Add command"
      >
        +
      </button>
      {adding && onAddCommand && (
        <form
          className="tab-command-form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <input
            className="tab-command-input"
            autoFocus
            value={draft}
            placeholder="shell command"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={cancel}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel()
            }}
          />
        </form>
      )}
      {commands.map((item, i) => {
        const active = running[item.runKey] != null
        const label = `${item.presetName}: ${item.command}`
        return (
          <Fragment key={`${item.presetIndex}:${item.index}`}>
            {i > 0 && commands[i - 1].presetIndex !== item.presetIndex && (
              <span className="tab-command-divider" />
            )}
            <button
              className={`tab-command${active ? ' tab-command-active' : ''}`}
              onClick={() => onToggleCommand(item)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ item, x: e.clientX, y: e.clientY })
              }}
              title={active ? `Stop: ${label}` : label}
            >
              {!active ? '' : ''}
            </button>
          </Fragment>
        )
      })}
      <span className="tabbar-divider" />
      <button
        className="tab-split"
        onClick={onSplit}
        onContextMenu={(e) => {
          e.preventDefault()
          if (!canSplit) return
          const r = e.currentTarget.getBoundingClientRect()
          setSplitMenu({ x: r.left, y: r.bottom + 4 })
        }}
        disabled={!canSplit}
        title="Split terminal (right-click for presets)"
      >
        
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button className="context-menu-item" onClick={() => removeCommand(menu.item)}>
            Remove “{menu.item.command}” from {menu.item.presetName}
          </button>
        </ContextMenu>
      )}
      {groupMenu && (
        <ContextMenu x={groupMenu.x} y={groupMenu.y} onClose={() => setGroupMenu(null)}>
          {groupMenu.preset && (
            <button
              className="context-menu-item context-menu-item--action"
              onClick={() => {
                onAddGroup(groupMenu.preset!)
                setGroupMenu(null)
              }}
            >
              New tab
            </button>
          )}
          <button
            className="context-menu-item context-menu-item--action"
            onClick={() => {
              onCloseGroup(groupMenu.ids)
              setGroupMenu(null)
            }}
          >
            Close all
          </button>
        </ContextMenu>
      )}
      {addMenu && (
        <ContextMenu x={addMenu.x} y={addMenu.y} onClose={() => setAddMenu(null)}>
          <button
            className="context-menu-item context-menu-item--action"
            onClick={() => {
              onOpenBrowser()
              setAddMenu(null)
            }}
          >
            New browser tab
          </button>
        </ContextMenu>
      )}
      {splitMenu && (
        <ContextMenu x={splitMenu.x} y={splitMenu.y} onClose={() => setSplitMenu(null)}>
          {presets.map((preset, i) => (
            <button
              key={i}
              className="context-menu-item context-menu-item--action"
              onClick={() => {
                onSplitWithPreset(preset)
                setSplitMenu(null)
              }}
            >
              Split with {preset.name}
            </button>
          ))}
        </ContextMenu>
      )}
    </div>
  )
}

export default memo(TabBar)
