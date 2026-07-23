interface TabBarProps {
  sessions: { id: number }[]
  activeId: number | 'home'
  labels: Record<number, string>
  onSelect: (id: number | 'home') => void
  onClose: (id: number) => void
  onAdd: () => void
}

function TabBar({
  sessions,
  activeId,
  labels,
  onSelect,
  onClose,
  onAdd
}: TabBarProps): React.JSX.Element {
  return (
    <div className="tabbar">
      <button
        className={`tab-home${activeId === 'home' ? ' tab-active' : ''}`}
        onClick={() => onSelect('home')}
        title="Home"
      >
        ⌂
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
            ×
          </button>
        </div>
      ))}
      <button className="tab-add" onClick={onAdd} title="New session">
        +
      </button>
    </div>
  )
}

export default TabBar
