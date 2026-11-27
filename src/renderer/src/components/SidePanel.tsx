import { Fragment } from 'react'
import { panelViews, type PanelView } from '../appModel'
import CodeLinksList, { type CodeLinksListProps } from './CodeLinksList'
import GitView, { type GitViewProps } from './GitPanel'

interface PanelTab {
  icon: string
  title: string
  keepMounted?: boolean
  render: (hidden: boolean) => React.ReactNode
}

interface SidePanelProps {
  width?: number
  collapsed?: boolean
  panelRef?: React.RefObject<HTMLDivElement | null>
  view: PanelView
  onViewChange: (view: PanelView) => void
  git: GitViewProps
  links: CodeLinksListProps
}

function SidePanel({
  width,
  collapsed = false,
  panelRef,
  view,
  onViewChange,
  git,
  links
}: SidePanelProps): React.JSX.Element {
  const tabs: Record<PanelView, PanelTab> = {
    git: {
      icon: '\u{e702}',
      title: 'Git',
      keepMounted: true,
      render: (hidden) => <GitView hidden={hidden} {...git} />
    },
    links: {
      icon: '\u{f0339}',
      title: 'Code links',
      render: () => <CodeLinksList {...links} />
    }
  }
  const style: React.CSSProperties | undefined = collapsed
    ? { display: 'none' }
    : width != null
      ? { flexBasis: width }
      : undefined

  return (
    <div className="git-panel" style={style} ref={panelRef}>
      <div className="git-panel-tabs" role="tablist">
        {panelViews.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={view === key}
            aria-label={tabs[key].title}
            title={tabs[key].title}
            className={`git-panel-tab${view === key ? ' git-panel-tab-active' : ''}`}
            onClick={() => onViewChange(key)}
          >
            {tabs[key].icon}
          </button>
        ))}
      </div>
      {panelViews.map((key) =>
        key === view || tabs[key].keepMounted ? (
          <Fragment key={key}>{tabs[key].render(key !== view)}</Fragment>
        ) : null
      )}
    </div>
  )
}

export default SidePanel
