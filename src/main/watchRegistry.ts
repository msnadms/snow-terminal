import { samePath } from './config'

export interface WatcherHandle {
  wcId: number
  count: number
  close: () => void
  root?: string
  notify?: () => void
}

export class WatcherRegistry {
  private entries = new Map<string, WatcherHandle>()

  begin(key: string, wcId: number): WatcherHandle | null {
    const existing = this.entries.get(key)
    if (existing) {
      existing.count++
      return null
    }
    const handle: WatcherHandle = { wcId, count: 1, close: () => {} }
    this.entries.set(key, handle)
    return handle
  }

  isCurrent(key: string, handle: WatcherHandle): boolean {
    return this.entries.get(key) === handle
  }

  notify(root: string): void {
    for (const handle of this.entries.values()) {
      if (handle.root && samePath(handle.root, root)) handle.notify?.()
    }
  }

  bail(key: string, handle: WatcherHandle): void {
    if (this.entries.get(key) === handle) this.entries.delete(key)
    handle.close()
  }

  release(key: string): void {
    const handle = this.entries.get(key)
    if (!handle) return
    if (handle.count > 1) {
      handle.count--
      return
    }
    this.entries.delete(key)
    handle.close()
  }

  closeFor(wcId: number): void {
    for (const [key, handle] of this.entries) {
      if (handle.wcId !== wcId) continue
      this.entries.delete(key)
      handle.close()
    }
  }

  disposeAll(): void {
    for (const handle of this.entries.values()) handle.close()
    this.entries.clear()
  }
}

export const contentWatchers = new WatcherRegistry()
export const repoWatchers = new WatcherRegistry()
