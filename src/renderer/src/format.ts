export function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

export function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export interface Failure {
  title: string
  detail: string
}

const remoteMethodPrefix = /^Error invoking remote method '[^']*':\s*/

export function failureOfError(error: unknown): Failure {
  const raw = (error instanceof Error ? error.message : String(error)).replace(
    remoteMethodPrefix,
    ''
  )
  const lines = raw.split('\n').map((l) => l.trimEnd())
  return {
    title: lines[0]?.trim() || 'git command failed',
    detail: lines.slice(1).join('\n').trim()
  }
}

export function failureOf(result: { error?: string; detail?: string }): Failure {
  const title = result.error ?? 'git command failed'
  const lines = (result.detail ?? '').split('\n')
  const body = lines[0]?.trim() === title ? lines.slice(1) : lines
  return { title, detail: body.join('\n').trim() }
}
