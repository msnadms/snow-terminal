import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'

interface PaneBoundaryProps {
  label: string
  active?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
}

interface PaneBoundaryState {
  error: Error | null
}

class PaneBoundary extends Component<PaneBoundaryProps, PaneBoundaryState> {
  state: PaneBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): PaneBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.label} crashed:`, error, info.componentStack)
  }

  private retry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    const { label, active = true, className, style, children } = this.props
    if (!error) return children
    if (!active) return null
    return (
      <div className={`pane-error${className ? ` ${className}` : ''}`} style={style} role="alert">
        <div className="pane-error-title">{label} crashed</div>
        <pre className="pane-error-detail">{error.message || String(error)}</pre>
        <button type="button" className="pane-error-retry" onClick={this.retry}>
          Reload {label.toLowerCase()}
        </button>
      </div>
    )
  }
}

export default PaneBoundary
