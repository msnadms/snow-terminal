export function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

export function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export interface Failure {
  title: string
  detail: string
}

export function failureOf(result: { error?: string; detail?: string }): Failure {
  const title = result.error ?? 'git command failed'
  const lines = (result.detail ?? '').split('\n')
  const body = lines[0]?.trim() === title ? lines.slice(1) : lines
  return { title, detail: body.join('\n').trim() }
}
