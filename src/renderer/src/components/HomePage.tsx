import { useEffect, useRef, useState } from 'react'
import type { Preset } from '../useSnowconfig'
import ContextMenu from './ContextMenu'
import SnowFall from './SnowFall'
import ThemeSelect from './ThemeSelect'

interface HomePageProps {
  presets: Preset[]
  name: string | null
  theme: string
  error: string | null
  onOpenPreset: (cwd: string) => void
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function chooseGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function HomePage({
  presets,
  name: greetingName,
  theme,
  error,
  onOpenPreset
}: HomePageProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!name && !cwd) return

    const onPointerDown = (e: PointerEvent): void => {
      if (formRef.current?.contains(e.target as Node)) return
      setName('')
      setCwd('')
    }

    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [name, cwd])

  const chooseFolder = async (): Promise<void> => {
    const dir = await window.api.snowconfig.chooseDir()
    if (!dir) return
    setCwd(dir)
    if (!name.trim() || (cwd && name === basename(cwd))) setName(basename(dir))
    requestAnimationFrame(() => nameRef.current?.focus())
  }

  const addPreset = (e: React.FormEvent): void => {
    e.preventDefault()
    const trimmedName = name.trim()
    const trimmedCwd = cwd.trim()
    if (!trimmedName || !trimmedCwd) return
    window.api.snowconfig.addPreset({ name: trimmedName, cwd: trimmedCwd })
    setName('')
    setCwd('')
  }

  const toggleDefault = (index: number, isDefault: boolean): void => {
    window.api.snowconfig.setDefault(isDefault ? -1 : index)
  }

  const removePreset = (index: number): void => {
    setMenu(null)
    window.api.snowconfig.removePreset(index)
  }

  return (
    <div className="home-page">
      <SnowFall />
      <ThemeSelect value={theme} onChange={(name) => window.api.snowconfig.setTheme(name)} />
      <div className="home-content">
        <div className="home-title">
          {greetingName ? `${chooseGreeting()}, ${greetingName}` : 'snow'}
        </div>
        {error && (
          <div className="home-error">
            <div className="home-error-title">
              Presets are not editable until this file is fixed
            </div>
            <pre className="home-error-detail">{error}</pre>
          </div>
        )}
        <div className="home-presets">
          {presets.map((preset, i) => (
            <div
              key={i}
              className="home-preset"
              onContextMenu={(e) => {
                if (error) return
                e.preventDefault()
                setMenu({ index: i, x: e.clientX, y: e.clientY })
              }}
            >
              <button className="home-preset-open" onClick={() => onOpenPreset(preset.cwd)}>
                <span className="home-preset-name">{preset.name}</span>
                <span className="home-preset-cwd">{preset.cwd}</span>
              </button>
              <input
                type="checkbox"
                className="home-preset-default"
                checked={!!preset.default}
                disabled={!!error}
                onChange={() => toggleDefault(i, !!preset.default)}
                title="Open with the new-tab button"
              />
            </div>
          ))}
        </div>
        <form className="home-add" ref={formRef} onSubmit={addPreset}>
          <input
            ref={nameRef}
            className="home-add-input"
            placeholder="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className={`home-add-choose${cwd ? '' : ' home-add-choose-empty'}`}
            onClick={chooseFolder}
            aria-label="Choose folder"
            title={cwd || 'Choose folder…'}
          >
            <span className={`nerd-folder${cwd ? ' has-dir' : ''}`}>{''}</span>
          </button>
          <button
            className="home-add-button"
            type="submit"
            disabled={!!error || !name.trim() || !cwd.trim()}
          >
            Add preset
          </button>
        </form>
      </div>
      {menu && presets[menu.index] && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button className="context-menu-item" onClick={() => removePreset(menu.index)}>
            Remove “{presets[menu.index].name}”
          </button>
        </ContextMenu>
      )}
    </div>
  )
}

export default HomePage
