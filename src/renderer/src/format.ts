export function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

export function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
