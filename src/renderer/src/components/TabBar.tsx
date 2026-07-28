import { useState } from 'react'
import ContextMenu from './ContextMenu'

interface TabBarProps {
  sessions: { id: number }[]
  activeId: number | 'home'
  labels: Record<number, string>
  commands: string[]
  runningCommands: string[]
  onSelect: (id: number | 'home') => void
  onClose: (id: number) => void
  onAdd: () => void
  onOpenBrowser: () => void
  onSplit: () => void
  onToggleCommand: (command: string) => void
  onAddCommand: (command: string) => void
  onRemoveCommand: (index: number) => void
  canManageCommands: boolean
  canSplit: boolean
}

function TabBar({
  sessions,
  activeId,
  labels,
  commands,
  runningCommands,
  onSelect,
  onClose,
  onAdd,
  onOpenBrowser,
  onSplit,
  onToggleCommand,
  onAddCommand,
  onRemoveCommand,
  canManageCommands,
  canSplit
}: TabBarProps): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)

  const submit = (): void => {
    const command = draft.trim()
    if (command) onAddCommand(command)
    setDraft('')
    setAdding(false)
  }

  const cancel = (): void => {
    setDraft('')
    setAdding(false)
  }

  const removeCommand = (index: number): void => {
    setMenu(null)
    const command = commands[index]
    if (command && runningCommands.includes(command)) onToggleCommand(command)
    onRemoveCommand(index)
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
      {sessions.map(({ id }) => (
        <div
          key={id}
          className={`tab${activeId === id ? ' tab-active' : ''}`}
          onClick={() => onSelect(id)}
        >
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
      ))}
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
        disabled={!canManageCommands}
        title="Add command"
      >
        +
      </button>
      {adding && canManageCommands && (
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
      {commands.map((command, i) => {
        const active = runningCommands.includes(command)
        return (
          <button
            key={i}
            className={`tab-command${active ? ' tab-command-active' : ''}`}
            onClick={() => onToggleCommand(command)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ index: i, x: e.clientX, y: e.clientY })
            }}
            disabled={!active && !canManageCommands}
            title={active ? `Stop: ${command}` : command}
          >
            {!active ? '' : ''}
          </button>
        )
      })}
      <span className="tabbar-divider" />
      <button className="tab-split" onClick={onSplit} disabled={!canSplit} title="Split terminal">
        
      </button>
      {menu && commands[menu.index] && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button className="context-menu-item" onClick={() => removeCommand(menu.index)}>
            Remove “{commands[menu.index]}”
          </button>
        </ContextMenu>
      )}
    </div>
  )
}

export default TabBar
