import { useState } from 'react'
import ActionBar from './components/ActionBar'
import Terminal from './components/Terminal'
import GitPanel from './components/GitPanel'

function App(): React.JSX.Element {
  const [cwd, setCwd] = useState<string | undefined>(undefined)

  return (
    <div className="app">
      <ActionBar cwd={cwd} />
      <div className="content">
        <div className="terminal-host">
          <div className="terminal-main">
            <Terminal startupCommand="claude" />
          </div>
          <div className="terminal-secondary">
            <Terminal onCwd={setCwd} />
          </div>
        </div>
        <GitPanel cwd={cwd} />
      </div>
    </div>
  )
}

export default App
