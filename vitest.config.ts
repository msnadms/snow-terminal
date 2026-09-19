import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      electron: resolve('tests/support/electron.ts'),
      'node-pty': resolve('tests/support/nodePty.ts')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
