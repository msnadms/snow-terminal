import { distance, toHex, toLab, type Lab } from '@renderer/color'
import { normalizePath } from '@renderer/format'
import { fallbackLanes } from '@renderer/useGitColors'

const laneSeparation = 0.1
const hueSteps = 24
const lightnessShifts = [0, 0.1, -0.1]
const lightnessRange = [0.38, 0.92]

function hash(key: string): number {
  let value = 2166136261
  for (let i = 0; i < key.length; i++) {
    value ^= key.charCodeAt(i)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function repoKey(path: string): string {
  return normalizePath(path).toLowerCase()
}

function variants(hex: string): string[] {
  const color = toLab(hex)
  if (!color) return []
  const [lightness, a, b] = color
  const chroma = Math.hypot(a, b)
  const hue = Math.atan2(b, a)
  const [floor, ceiling] = lightnessRange
  return Array.from({ length: hueSteps - 1 }, (_, step) => {
    const turned = hue + ((step + 1) * 2 * Math.PI) / hueSteps
    return lightnessShifts.map((shift) =>
      toHex([
        Math.min(ceiling, Math.max(floor, lightness + shift)),
        chroma * Math.cos(turned),
        chroma * Math.sin(turned)
      ])
    )
  }).flat()
}

function separation(candidate: string, taken: Lab[]): number {
  const color = toLab(candidate)
  if (!color) return 0
  if (taken.length === 0) return Infinity
  return Math.min(...taken.map((other) => distance(color, other)))
}

type Assignments = {
  palette: string
  colors: Map<string, string>
  used: Set<string>
  taken: Lab[]
}

let assigned: Assignments | null = null

function furthest(candidates: string[], taken: Lab[]): { color: string; score: number } | null {
  return candidates.reduce<{ color: string; score: number } | null>((best, candidate) => {
    const score = separation(candidate, taken)
    return best && best.score >= score ? best : { color: candidate, score }
  }, null)
}

function claim(palette: string[], preferred: number, taken: Lab[]): string {
  const order = palette.map((_, offset) => palette[(preferred + offset) % palette.length])
  const free = order.filter((lane) => !assigned?.used.has(lane))
  const lane = furthest(free.length > 0 ? free : [palette[preferred]], taken)
  if (!lane) return palette[preferred]
  if (lane.score >= laneSeparation) return lane.color
  const turned = furthest(variants(lane.color), taken)
  return turned && turned.score > lane.score ? turned.color : lane.color
}

export function repoColor(path: string, lanes?: string[]): string {
  const palette = lanes?.length ? lanes : fallbackLanes
  const paletteKey = palette.join(' ')
  if (assigned?.palette !== paletteKey)
    assigned = { palette: paletteKey, colors: new Map(), used: new Set(), taken: [] }

  const key = repoKey(path)
  const held = assigned.colors.get(key)
  if (held) return held

  const color = claim(palette, hash(key) % palette.length, assigned.taken)
  const point = toLab(color)
  assigned.colors.set(key, color)
  assigned.used.add(color)
  if (point) assigned.taken.push(point)
  return color
}
