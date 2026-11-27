import type { TabTurn, CodeLinkTarget, TabCodeLinks } from '@renderer/appModel'

export interface CodeLinksListProps {
  links?: TabCodeLinks
  turn?: TabTurn
  onOpenLink?: (target: Omit<CodeLinkTarget, 'key'>) => void
  onOpenTurn?: () => void
}

function split(file: string): { dir: string; name: string } {
  const at = file.lastIndexOf('/')
  return at === -1
    ? { dir: '', name: file }
    : { dir: file.slice(0, at + 1), name: file.slice(at + 1) }
}

function CodeLinksList({
  links,
  turn,
  onOpenLink,
  onOpenTurn
}: CodeLinksListProps): React.JSX.Element {
  if (!turn && (!links || links.items.length === 0))
    return <div className="git-empty">No code links from the agent yet</div>

  return (
    <div className="code-links">
      {turn && (
        <button
          className="code-link-row code-link-turn"
          disabled={!onOpenTurn}
          title={`Changes since this turn's prompt\n${turn.root}`}
          onClick={() => onOpenTurn?.()}
        >
          <span className="code-link-name">
            {turn.end || !turn.live ? 'Last turn' : 'Current turn'}
          </span>
          <span className="code-link-turn-state">
            {turn.end ? 'changes' : turn.live ? 'in progress' : 'unfinished'}
          </span>
        </button>
      )}
      {links?.items.map((link) => {
        const { dir, name } = split(link.path)
        const lines = link.line ? `:${link.line}${link.endLine ? `-${link.endLine}` : ''}` : ''
        return (
          <button
            key={`${link.path}:${link.line ?? ''}-${link.endLine ?? ''}`}
            className="code-link-row"
            disabled={!onOpenLink}
            title={`${link.path}${lines}`}
            onClick={() => onOpenLink?.({ root: links.root, ...link })}
          >
            <span className="code-link-dir">{dir}</span>
            <span className="code-link-name">{name}</span>
            {lines && <span className="code-link-lines">{lines}</span>}
          </button>
        )
      })}
    </div>
  )
}

export default CodeLinksList
