import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const loopbackHosts = new Set(['127.0.0.1', '0.0.0.0', '::', '::1', '[::]', '[::1]'])
const httpTimeoutMs = 400
const enumerateTimeoutMs = 4000
const maxConcurrentProbes = 12

async function run(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: enumerateTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    })
    return stdout
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? ''
  }
}

function portOf(address: string): number | null {
  const cut = address.lastIndexOf(':')
  if (cut < 0) return null
  const host = address.slice(0, cut)
  const port = Number(address.slice(cut + 1))
  if (!Number.isInteger(port) || port <= 0) return null
  return loopbackHosts.has(host) ? port : null
}

async function listeningPorts(): Promise<number[]> {
  const ports = new Set<number>()

  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano'])
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (!/^TCP/.test(parts[0] ?? '') || parts[3] !== 'LISTENING') continue
      const port = portOf(parts[1])
      if (port) ports.add(port)
    }
  } else {
    const out =
      (await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'n'])) ||
      (await run('ss', ['-ltnH']))
    for (const line of out.split('\n')) {
      const field = line.startsWith('n') ? line.slice(1) : (line.trim().split(/\s+/)[3] ?? '')
      const address = field.replace(/^\*:/, '0.0.0.0:')
      const port = portOf(address)
      if (port) ports.add(port)
    }
  }

  return [...ports].sort((a, b) => a - b)
}

function probePage(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let head = ''
    const done = (): void => {
      socket.destroy()
      resolve(/^HTTP\/1\.[01] 200/.test(head) && /\r\ncontent-type:\s*text\/html/i.test(head))
    }
    socket.setTimeout(httpTimeoutMs)
    socket.once('connect', () =>
      socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    )
    socket.on('data', (chunk) => {
      head += chunk.toString('latin1')
      if (head.length > 2048 || head.includes('\r\n\r\n')) done()
    })
    socket.once('timeout', done)
    socket.once('end', done)
    socket.once('error', () => resolve(false))
  })
}

async function servesPage(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([probePage('127.0.0.1', port), probePage('::1', port)])
  return v4 || v6
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export async function scanLocalhost(): Promise<number[]> {
  const ports = await listeningPorts()
  const answers = await mapWithLimit(ports, maxConcurrentProbes, servesPage)
  return ports.filter((_, i) => answers[i])
}

export function registerLocalhostHandlers(): void {
  ipcMain.handle('localhost:scan', () => scanLocalhost())
}
