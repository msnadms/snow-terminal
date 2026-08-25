export type Lab = [number, number, number]

function channels(hex: string): [number, number, number] | null {
  const body = hex.trim().slice(1)
  const short = body.length === 3 || body.length === 4
  if (!short && body.length !== 6 && body.length !== 8) return null
  const width = short ? 1 : 2
  const parts = [0, 1, 2].map((i) => {
    const digits = body.slice(i * width, (i + 1) * width)
    return parseInt(short ? digits + digits : digits, 16)
  })
  return parts.some(Number.isNaN) ? null : (parts as [number, number, number])
}

function linear(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function encode(value: number): string {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, c)) * 255)
    .toString(16)
    .padStart(2, '0')
}

export function toLab(hex: string): Lab | null {
  const rgb = channels(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map(linear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

export function toHex([lightness, a, b]: Lab): string {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return `#${encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)}${encode(
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  )}${encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)}`
}

export function distance(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function luminance(hex: string): number | null {
  const rgb = channels(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const first = luminance(a)
  const second = luminance(b)
  if (first === null || second === null) return 1
  const [light, dark] = first >= second ? [first, second] : [second, first]
  return (light + 0.05) / (dark + 0.05)
}
