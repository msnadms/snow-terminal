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
Promise.allSettled([
  document.fonts.load(`13px "${font}"`),
  document.fonts.load(`bold 13px "${font}"`),
  document.fonts.load(`italic 13px "${font}"`),
  document.fonts.load(`bold italic 13px "${font}"`)
]).finally(render)
