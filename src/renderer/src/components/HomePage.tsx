import { useState } from 'react'
import type { Preset } from '../useSnowconfig'

interface HomePageProps {
  presets: Preset[]
  onOpenPreset: (cwd: string) => void
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function HomePage({ presets, onOpenPreset }: HomePageProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')

  const chooseFolder = async (): Promise<void> => {
    const dir = await window.api.snowconfig.chooseDir()
    if (!dir) return
    setCwd(dir)
    if (!name.trim()) setName(basename(dir))
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

  return (
    <div className="home-page">
      <div className="home-title">snow</div>
      <div className="home-presets">
        {presets.map((preset, i) => (
          <div key={i} className="home-preset">
            <button className="home-preset-open" onClick={() => onOpenPreset(preset.cwd)}>
              <span className="home-preset-name">{preset.name}</span>
              <span className="home-preset-cwd">{preset.cwd}</span>
            </button>
            <input
              type="checkbox"
              className="home-preset-default"
              checked={!!preset.default}
              onChange={() => toggleDefault(i, !!preset.default)}
              title="Open with the new-tab button"
            />
          </div>
        ))}
      </div>
      <form className="home-add" onSubmit={addPreset}>
        <input
          className="home-add-input"
          placeholder="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className={`home-add-choose${cwd ? '' : ' home-add-choose-empty'}`}
          onClick={chooseFolder}
          title={cwd}
        >
          {cwd || 'Choose folder…'}
        </button>
        <button className="home-add-button" type="submit" disabled={!name.trim() || !cwd.trim()}>
          Add preset
        </button>
      </form>
    </div>
  )
}

export default HomePage
