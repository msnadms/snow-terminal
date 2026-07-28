import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

function render(): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

const font = 'Hack Nerd Font Mono'

document.fonts
  .load(`13px "${font}"`)
  .catch(() => undefined)
  .finally(render)
