import os from 'os'
import path from 'path'

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, 'snow')
}
