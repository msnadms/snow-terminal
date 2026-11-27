import { memo, useMemo } from 'react'
import CodeLinkView from './CodeLinkView'

interface FileTabProps {
  active: boolean
  id: number
  root: string
  path: string
  onOpenCommit: (cwd: string, hash: string) => void
  onClose: (id: number) => void
}

function FileTab({
  active,
  id,
  root,
  path,
  onOpenCommit,
  onClose
}: FileTabProps): React.JSX.Element {
  const target = useMemo(() => ({ root, path, key: id }), [root, path, id])
  return (
    <CodeLinkView
      active={active}
      target={target}
      onOpenCommit={onOpenCommit}
      onClose={() => onClose(id)}
    />
  )
}

export default memo(FileTab)
