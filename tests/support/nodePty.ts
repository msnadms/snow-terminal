export function spawn(): never {
  throw new Error('node-pty is not available in tests')
}

export type IPty = never
