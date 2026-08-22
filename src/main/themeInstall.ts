import { net } from 'electron'
import fs from 'fs'
import { log } from './log'
import { setActiveTheme } from './snowconfig'
import { themeFile, themesDir, validateTheme } from './theme'

export interface ThemeInstallResult {
  name: string | null
  path: string | null
  error: string | null
  detail: string
}

const maxThemeBytes = 256 * 1024
const requestTimeoutMs = 15000
const themeName = /^[A-Za-z0-9_-]+$/

function sourceUrl(source: string): URL | null {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.hostname !== 'github.com') return url

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[2] !== 'blob' || parts.length < 5) return url
  const raw = [...parts.slice(0, 2), ...parts.slice(3)].map(encodeURIComponent).join('/')
  return new URL(`https://raw.githubusercontent.com/${raw}`)
}

function nameFromUrl(url: URL): string {
  let base: string
  try {
    base = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
  } catch {
    return ''
  }
  if (!/\.json$/i.test(base)) return ''
  return base
    .slice(0, -'.json'.length)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function download(url: URL): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
  try {
    const response = await net.fetch(url.toString(), { signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim())
    if (Number(response.headers.get('content-length')) > maxThemeBytes)
      throw new Error('the file is larger than 256 kB')

    const reader = response.body?.getReader()
    if (!reader) throw new Error('the response had no body')

    const chunks: Buffer[] = []
    let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxThemeBytes) {
        controller.abort()
        void reader.cancel().catch(() => {})
        throw new Error('the file is larger than 256 kB')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, bytes).toString('utf8')
  } finally {
    clearTimeout(timer)
  }
}

export async function installTheme(
  source: string,
  requested: string | null,
  force: boolean
): Promise<ThemeInstallResult> {
  const fail = (error: string, detail = ''): ThemeInstallResult => {
    log('error', 'theme', 'install failed', { source, error, detail })
    return { name: null, path: null, error, detail }
  }

  const url = sourceUrl(source)
  if (!url) return fail('Not an https URL', source)

  const name = requested ?? nameFromUrl(url)
  if (!themeName.test(name))
    return fail(
      'Could not name the theme',
      `"${name || source}" is not a usable theme name. Pass one explicitly: snow theme <url> <name>`
    )

  const file = themeFile(name)
  if (!force && fs.existsSync(file))
    return fail(
      `A theme named "${name}" is already installed`,
      `${file}\n\nPass a different name, or --force to overwrite it.`
    )

  let parsed: unknown
  try {
    parsed = JSON.parse(await download(url))
  } catch (err) {
    const message = (err as Error).message
    return fail(`Could not read ${url.hostname}`, `${url.toString()}\n\n${message}`)
  }

  const { errors, missing } = validateTheme(parsed)
  if (errors.length > 0)
    return fail('Not a valid snow theme', [url.toString(), '', ...errors.slice(0, 12)].join('\n'))

  try {
    fs.mkdirSync(themesDir(), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`)
  } catch (err) {
    return fail('Could not write the theme file', `${file}\n\n${(err as Error).message}`)
  }

  const detail = missing.length > 0 ? `Using defaults for: ${missing.join(', ')}` : ''
  const { error } = setActiveTheme(name)
  if (error)
    return {
      name,
      path: file,
      error: `Installed "${name}", but could not make it active`,
      detail: `${error}\n\nPick it from the theme menu instead.`
    }

  log('info', 'theme', 'installed', { source, name, path: file, missing: missing.length })
  return { name, path: file, error: null, detail }
}
