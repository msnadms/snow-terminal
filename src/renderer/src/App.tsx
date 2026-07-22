import { useState } from 'react'
import Terminal from './components/Terminal'
import GitPanel from './components/GitPanel'

function App(): React.JSX.Element {
  const [cwd, setCwd] = useState<string | undefined>(undefined)

  return (
    <div className="app">
      <div className="titlebar">snow - terminal</div>
      <div className="content">
        <div className="terminal-host">
          <Terminal onCwd={setCwd} />
        </div>
        <GitPanel cwd={cwd} />
      </div>
    </div>
  )
}

export default App
