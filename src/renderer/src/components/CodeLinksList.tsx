import type { CodeLinkTarget, TabCodeLinks } from '@renderer/appModel'

interface CodeLinksListProps {
  links?: TabCodeLinks
  onOpenLink?: (target: Omit<CodeLinkTarget, 'key'>) => void
}

function split(file: string): { dir: string; name: string } {
  const at = file.lastIndexOf('/')
  return at === -1
    ? { dir: '', name: file }
    : { dir: file.slice(0, at + 1), name: file.slice(at + 1) }
}

function CodeLinksList({ links, onOpenLink }: CodeLinksListProps): React.JSX.Element {
  if (!links || links.items.length === 0)
    return <div className="git-empty">No code links from the agent yet</div>

  return (
    <div className="code-links">
      {links.items.map((link) => {
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
