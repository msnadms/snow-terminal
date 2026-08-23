import { useEffect, useRef, useState } from 'react'
import { visiblePresetEntries, type Preset } from '../useSnowconfig'
import ContextMenu from './ContextMenu'
import HooksPrompt from './HooksPrompt'
import SnowFall from './SnowFall'
import ThemeSelect from './ThemeSelect'

interface HomePageProps {
  active: boolean
  presets: Preset[]
  name: string | null
  theme: string
  error: string | null
  hooksPrompted: boolean
  onOpenPreset: (preset: Preset) => void
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
  active,
  presets,
  name: greetingName,
  theme,
  error,
  hooksPrompted,
  onOpenPreset
}: HomePageProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [startupCommand, setStartupCommand] = useState('')
  const [hidden, setHidden] = useState(false)
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  const [edit, setEdit] = useState<{ index: number; value: string } | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const editRef = useRef<HTMLInputElement>(null)

  const formDirty = !!(name || cwd || startupCommand || hidden)

  useEffect(() => {
    if (!formDirty) return

    const onPointerDown = (e: PointerEvent): void => {
      if (formRef.current?.contains(e.target as Node)) return
      setName('')
      setCwd('')
      setStartupCommand('')
      setHidden(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [formDirty])

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
    const trimmedStartup = startupCommand.trim()
    if (!trimmedName || !trimmedCwd) return
    if (presets.some((p) => p.name === trimmedName)) return
    window.api.snowconfig.addPreset({
      name: trimmedName,
      cwd: trimmedCwd,
      ...(trimmedStartup ? { startupCommand: trimmedStartup } : {}),
      ...(hidden ? { hidden: true } : {})
    })
    setName('')
    setCwd('')
    setStartupCommand('')
    setHidden(false)
  }

  const toggleDefault = (index: number, isDefault: boolean): void => {
    window.api.snowconfig.setDefault(isDefault ? -1 : index)
  }

  const removePreset = (index: number): void => {
    setMenu(null)
    window.api.snowconfig.removePreset(index)
  }

  const addSplit = (index: number, name: string): void => {
    setMenu(null)
    window.api.snowconfig.addSplit(index, name)
  }

  const removeSplit = (index: number): void => {
    setMenu(null)
    window.api.snowconfig.removeSplit(index)
  }

  const startEdit = (index: number): void => {
    setMenu(null)
    setEdit({ index, value: presets[index]?.startupCommand ?? '' })
    requestAnimationFrame(() => editRef.current?.focus())
  }

  const commitEdit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!edit) return
    window.api.snowconfig.setStartupCommand(edit.index, edit.value.trim())
    setEdit(null)
  }

  const nameExists = presets.some((p) => p.name === name.trim())
  const visibleEntries = visiblePresetEntries(presets)

  return (
    <div className="home-page" style={{ display: active ? 'flex' : 'none' }}>
      <SnowFall active={active} />
      <ThemeSelect value={theme} onChange={(name) => window.api.snowconfig.setTheme(name)} />
      <button
        className="home-config"
        onClick={() => window.api.snowconfig.openConfigDir()}
        title="Open ~/.config/snow"
      >
        <span className="home-config-icon">{''}</span>
        <span>config</span>
      </button>
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
        <HooksPrompt prompted={hooksPrompted} />
        <div className="home-presets">
          {visibleEntries.map(({ preset, index: i }) => (
            <div
              key={i}
              className="home-preset"
              onContextMenu={(e) => {
                if (error) return
                e.preventDefault()
                setMenu({ index: i, x: e.clientX, y: e.clientY })
              }}
            >
              {edit?.index === i ? (
                <form className="home-preset-edit" onSubmit={commitEdit}>
                  <input
                    ref={editRef}
                    className="home-add-input home-preset-edit-input"
                    placeholder="startup command (blank clears)"
                    value={edit.value}
                    onChange={(e) => setEdit({ index: i, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEdit(null)
                    }}
                  />
                  <button className="home-add-button" type="submit">
                    Save
                  </button>
                </form>
              ) : (
                <button className="home-preset-open" onClick={() => onOpenPreset(preset)}>
                  <span className="home-preset-name">
                    {preset.name}
                    {preset.splits && preset.splits.length > 0 && (
                      <span
                        className="home-preset-splits"
                        title={`Opens as splits: ${preset.splits.join(', ')}`}
                      >
                        {`+${preset.splits.length}`}
                      </span>
                    )}
                  </span>
                  <span className="home-preset-cwd">{preset.cwd}</span>
                </button>
              )}
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
          <input
            className="home-add-input"
            placeholder="command"
            value={startupCommand}
            onChange={(e) => setStartupCommand(e.target.value)}
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
            type="button"
            className={`home-add-choose home-add-hide${hidden ? ' home-add-hide-on' : ' home-add-choose-empty'}`}
            onClick={() => setHidden(!hidden)}
            aria-pressed={hidden}
            aria-label="Hidden preset"
            title={
              hidden
                ? 'Hidden: offered only when adding a split to another preset'
                : 'Visible on the home page and the split menu'
            }
          >
            <span className="nerd-eye">{hidden ? '' : ''}</span>
          </button>
          <button
            className="home-add-button"
            type="submit"
            disabled={!!error || !name.trim() || !cwd.trim() || nameExists}
            title={nameExists ? `A preset named “${name.trim()}” already exists` : undefined}
          >
            Add preset
          </button>
        </form>
      </div>
      {menu && presets[menu.index] && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button className="context-menu-item" onClick={() => startEdit(menu.index)}>
            Edit startup command…
          </button>
          <div className="context-menu-label">Add split</div>
          {presets.map((preset, i) => (
            <div key={i} className="context-menu-row">
              <button
                className="context-menu-item context-menu-subitem"
                onClick={() => addSplit(menu.index, preset.name)}
              >
                {preset.name}
              </button>
              {preset.hidden && (
                <button
                  className="context-menu-item context-menu-remove"
                  onClick={() => removePreset(i)}
                  title={`Remove “${preset.name}”`}
                >
                  
                </button>
              )}
            </div>
          ))}
          {(presets[menu.index].splits?.length ?? 0) > 0 && (
            <button className="context-menu-item" onClick={() => removeSplit(menu.index)}>
              Remove last split
            </button>
          )}
          <button className="context-menu-item" onClick={() => removePreset(menu.index)}>
            Remove “{presets[menu.index].name}”
          </button>
        </ContextMenu>
      )}
    </div>
  )
}

export default HomePage
