interface PanelRestoreProps {
  className: string
  label: string
  title: string
  onClick: () => void
}

function PanelRestore({ className, label, title, onClick }: PanelRestoreProps): React.JSX.Element {
  return (
    <button className={`panel-restore ${className}`} onClick={onClick} title={title}>
      <span className="panel-restore-label">{label}</span>
    </button>
  )
}

export default PanelRestore
