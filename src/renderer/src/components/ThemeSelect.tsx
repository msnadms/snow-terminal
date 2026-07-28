import { useEffect, useRef, useState } from 'react'

interface ThemeSelectProps {
  value: string
  onChange: (name: string) => void
}

function ThemeSelect({ value, onChange }: ThemeSelectProps): React.JSX.Element {
  const [themes, setThemes] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const load = (): void => {
      window.api.theme.list().then(setThemes)
    }
    load()
    return window.api.theme.onChanged(load)
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  const select = (name: string): void => {
    setOpen(false)
    if (name !== value) onChange(name)
  }

  const options = themes.length ? themes : [value]

  return (
    <div className="home-theme" ref={ref}>
      {open && (
        <div className="home-theme-menu">
          {options.map((name) => (
            <button
              key={name}
              className={`home-theme-item${name === value ? ' home-theme-item-current' : ''}`}
              onClick={() => select(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <button className="home-theme-button" onClick={() => setOpen((o) => !o)}>
        <span className="home-theme-flake">❄</span>
        <span className="home-theme-name">{value}</span>
        <span className="home-theme-caret">▾</span>
      </button>
    </div>
  )
}

export default ThemeSelect
