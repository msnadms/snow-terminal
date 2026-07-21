import Terminal from './components/Terminal'

function App(): React.JSX.Element {
  return (
    <div className="app">
      <div className="titlebar">snow - terminal</div>
      <div className="terminal-host">
        <Terminal />
      </div>
    </div>
  )
}

export default App
