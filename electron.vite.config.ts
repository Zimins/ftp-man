import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

/** Strict CSP for the packaged renderer only; the dev server needs inline scripts and a websocket for HMR. */
const cspPlugin = (): Plugin => ({
  name: 'ftp-man-csp',
  apply: 'build',
  transformIndexHtml: (html) => ({
    html,
    tags: [
      {
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
        },
        injectTo: 'head-prepend'
      }
    ]
  })
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // CJS preload loads synchronously before page scripts and works with a sandboxed renderer.
    build: { rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    plugins: [react(), cspPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
