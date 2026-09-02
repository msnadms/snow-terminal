/**
 * A map bounded by insertion order, for answers that are pure functions of commit SHAs: they never
 * self-invalidate, so nothing but the bound ever evicts them.
 */
export interface BoundedCache<T> {
  get(key: string): T | undefined
  set(key: string, value: T): T
}

export function boundedCache<T>(limit: number): BoundedCache<T> {
  const entries = new Map<string, T>()
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.set(key, value)
      while (entries.size > limit) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
      return value
    }
  }
}
