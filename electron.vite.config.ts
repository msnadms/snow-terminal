import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // node-pty is a native module and must not be bundled by Vite/Rollup.
    plugins: [externalizeDepsPlugin({ exclude: [] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      // Vite's defaults plus 'worker'. decode-named-character-reference lists "worker"
      // before "browser" in its exports, and its browser build calls document.createElement
      // at module load — which throws in tokenize.worker before it can register onmessage.
      conditions: ['worker', 'module', 'browser', 'development|production'],
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
