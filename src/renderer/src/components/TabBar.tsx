import { Fragment, memo, useState } from 'react'
import ContextMenu from './ContextMenu'
import type { CommandItem, SessionStatus } from '../App'
import type { Preset } from '../useSnowconfig'

interface TabBarProps {
  sessions: { id: number }[]
  activeId: number | 'home'
  labels: Record<number, string>
  statuses: Record<number, SessionStatus>
  commands: CommandItem[]
  running: Record<string, number>
  presets: Preset[]
  onSelect: (id: number | 'home') => void
  onClose: (id: number) => void
  onReorder: (from: number, to: number) => void
  onAdd: () => void
  onOpenBrowser: () => void
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
  onReorder,
  onAdd,
  onOpenBrowser,
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
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)

  const insertAt = drag && drag.over !== drag.from && drag.over !== drag.from + 1 ? drag.over : null

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
      {sessions.map(({ id }, i) => {
        const drop =
          insertAt === i
            ? ' tab-drop-before'
            : insertAt === sessions.length && i === sessions.length - 1
              ? ' tab-drop-after'
              : ''
        return (
          <div
            key={id}
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
      })}
      <button className="tab-add" onClick={onAdd} title="New session">
        +
      </button>
      <button className="tab-browser" onClick={onOpenBrowser} title="New browser tab">
        󰖟
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
