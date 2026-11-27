import { app, ipcMain, shell } from 'electron'
import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { strictlyInside, worktreeRoot } from './gitCore'

export type Editor = 'vscode' | 'visualStudio'

export interface EditorAvailability {
  vscode: boolean
  visualStudio: boolean
}

interface VisualStudio {
  devenv: string
  progId: string
}

let devenvLookup: Promise<VisualStudio | null> | null = null

export function parseVswhere(stdout: string): VisualStudio | null {
  let found: unknown
  try {
    found = JSON.parse(stdout)
  } catch {
    return null
  }
  const latest = Array.isArray(found)
    ? (found[0] as Record<string, unknown> | undefined)
    : undefined
  const devenv = latest?.productPath
  const version = latest?.installationVersion
  if (typeof devenv !== 'string' || typeof version !== 'string') return null
  const major = /^(\d+)\./.exec(version)?.[1]
  if (!major) return null
  return { devenv, progId: `VisualStudio.DTE.${major}.0` }
}

function findVisualStudio(): Promise<VisualStudio | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (devenvLookup) return devenvLookup
  const lookup = new Promise<VisualStudio | null>((resolve, reject) => {
    const programs = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles
    if (!programs) return resolve(null)
    const vswhere = path.join(programs, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    if (!existsSync(vswhere)) return resolve(null)
    execFile(
      vswhere,
      ['-latest', '-format', 'json', '-utf8'],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) return reject(error)
        const found = parseVswhere(stdout)
        resolve(found && existsSync(found.devenv) ? found : null)
      }
    )
  })
  devenvLookup = lookup
  const forget = (): void => {
    if (devenvLookup === lookup) devenvLookup = null
  }
  lookup.then((found) => {
    if (!found) forget()
  }, forget)
  return lookup
}

const gotoInRunning = [
  "$ErrorActionPreference = 'Stop'",
  '$dte = [Runtime.InteropServices.Marshal]::GetActiveObject($env:SNOW_VS_PROGID)',
  '$dte.ItemOperations.OpenFile($env:SNOW_VS_FILE) | Out-Null',
  '$dte.ActiveDocument.Selection.GotoLine([int]$env:SNOW_VS_LINE, $false)',
  '$dte.MainWindow.Activate()'
].join('; ')

function openInRunning(vs: VisualStudio, file: string, line: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', gotoInRunning],
      {
        timeout: 10000,
        windowsHide: true,
        env: {
          ...process.env,
          SNOW_VS_PROGID: vs.progId,
          SNOW_VS_FILE: file,
          SNOW_VS_LINE: String(line)
        }
      },
      (error) => resolve(!error)
    )
  })
}

function hasVscode(): boolean {
  return app.getApplicationNameForProtocol('vscode://') !== ''
}

export function vscodeUrl(file: string, line?: number): string {
  const slashed = file.replace(/\\/g, '/')
  const absolute = slashed.startsWith('/') ? slashed : `/${slashed}`
  const encoded = absolute
    .split('/')
    .map((segment, i) => {
      const escaped = encodeURIComponent(segment)
      return i === 1 && /^[A-Za-z]%3A$/i.test(escaped) ? escaped.replace(/%3A/i, ':') : escaped
    })
    .join('/')
  return `vscode://file${encoded}${line ? `:${line}:1` : ''}`
}

async function resolveFile(cwd: string, rel: string): Promise<string> {
  const found = await worktreeRoot(cwd)
  if (!found) throw new Error(`Not a git repository: ${cwd}`)
  const root = path.resolve(found)
  const full = path.resolve(root, rel)
  if (!strictlyInside(root, full)) {
    throw new Error(`Refusing a path outside the repository: ${rel}`)
  }
  if (!existsSync(full)) throw new Error(`File no longer exists: ${rel}`)
  return full
}

async function openIn(editor: Editor, file: string, line?: number): Promise<void> {
  if (editor === 'vscode') {
    await shell.openExternal(vscodeUrl(file, line))
    return
  }
  const vs = await findVisualStudio()
  if (!vs) throw new Error('Visual Studio is not installed')
  if (line && (await openInRunning(vs, file, line))) return
  const args = ['/edit', file]
  if (line) args.push('/command', `Edit.GoTo ${line}`)
  const child = spawn(vs.devenv, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', (error) => console.error('[editors] devenv failed:', error))
  child.unref()
}

export function registerEditorHandlers(): void {
  ipcMain.handle('editor:available', async (): Promise<EditorAvailability> => ({
    vscode: hasVscode(),
    visualStudio: await findVisualStudio().then(
      (found) => found !== null,
      (error: unknown) => {
        console.error('[editors] vswhere failed:', error)
        return false
      }
    )
  }))
  ipcMain.handle(
    'editor:open',
    async (_event, editor: Editor, cwd: string, rel: string, line?: number): Promise<void> => {
      if (editor !== 'vscode' && editor !== 'visualStudio')
        throw new Error(`Unknown editor: ${editor}`)
      const valid = Number.isInteger(line) && (line as number) > 0 ? line : undefined
      await openIn(editor, await resolveFile(cwd, rel), valid)
    }
  )
}
