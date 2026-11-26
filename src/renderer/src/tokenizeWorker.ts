let worker: Worker | null = null

export function tokenizeWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./tokenize.worker.ts', import.meta.url), { type: 'module' })
  }
  return worker
}
