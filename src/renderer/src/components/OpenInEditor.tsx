import { useState } from 'react'
import { createPortal } from 'react-dom'
import { failureOfError, type Failure } from '@renderer/format'
import type { EditorAvailability } from '@renderer/useEditors'
import FailureDialog from './FailureDialog'

type Editor = Parameters<typeof window.api.editor.open>[0]

interface OpenInEditorProps {
  editors: EditorAvailability
  cwd: string
  path: string
  line?: number
}

function OpenInEditor({ editors, cwd, path, line }: OpenInEditorProps): React.JSX.Element {
  const [failure, setFailure] = useState<Failure | null>(null)

  const open = (editor: Editor): void => {
    window.api.editor.open(editor, cwd, path, line).catch((error) => {
      console.error('open in editor failed:', error)
      setFailure(failureOfError(error))
    })
  }

  return (
    <>
      {editors.vscode && (
        <button
          className="commit-toggle-button commit-file-action"
          onClick={() => open('vscode')}
          title="Open in VS Code"
        >
          <div className="commit-action-icon">{'\u{F0A1E}'}</div>
        </button>
      )}
      {editors.visualStudio && (
        <button
          className="commit-toggle-button commit-file-action"
          onClick={() => open('visualStudio')}
          title="Open in Visual Studio"
        >
          <div className="commit-action-icon">{'\u{F0610}'}</div>
        </button>
      )}
      {failure &&
        createPortal(
          <FailureDialog failure={failure} onDismiss={() => setFailure(null)} />,
          document.body
        )}
    </>
  )
}

export default OpenInEditor
