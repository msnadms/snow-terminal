import { computeNewLineNumber, computeOldLineNumber, getChangeKey } from 'react-diff-view'
import type { HunkData } from 'react-diff-view'
import type { CodeLink } from './appModel'

export type LineRange = { start: number; end: number }

export function rangeOf(link: CodeLink): LineRange | undefined {
  if (!link.line) return undefined
  return { start: link.line, end: link.endLine ?? link.line }
}

export const sourceWindowLines = 2000

export function sourceWindow(total: number, range?: LineRange): LineRange {
  if (total <= sourceWindowLines) return { start: 1, end: total }
  const center = range ? Math.floor((range.start + Math.min(range.end, total)) / 2) : 1
  const start = Math.max(1, Math.min(center - sourceWindowLines / 2, total - sourceWindowLines + 1))
  return { start, end: start + sourceWindowLines - 1 }
}

export function linkLabel(link: CodeLink): string {
  if (!link.line) return link.path
  return link.endLine ? `${link.path}:${link.line}-${link.endLine}` : `${link.path}:${link.line}`
}

export function firstChangedLine(hunks: HunkData[]): number | undefined {
  const hunk = hunks[0]
  if (!hunk) return undefined
  let line = hunk.newStart
  for (const change of hunk.changes) {
    if (change.type !== 'normal') return Math.max(1, line)
    line += 1
  }
  return Math.max(1, hunk.newStart)
}

export function selectedKeysFor(hunks: HunkData[], range: LineRange): string[] {
  const within = (n: number): boolean => n >= range.start && n <= range.end
  const changes = hunks.flatMap((hunk) => hunk.changes)
  const current = changes.filter((change) => within(computeNewLineNumber(change)))
  const picked =
    current.length > 0
      ? current
      : changes.filter((change) => change.type === 'delete' && within(computeOldLineNumber(change)))
  return picked.map(getChangeKey)
}

export function fileIndexFor(
  files: { path: string; oldPath?: string | null }[],
  file: string
): number {
  const exact = files.findIndex((entry) => entry.path === file)
  return exact !== -1 ? exact : files.findIndex((entry) => entry.oldPath === file)
}
