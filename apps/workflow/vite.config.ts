import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import https from 'node:https'

const upstreamAgent = new https.Agent({ keepAlive: false })
const proxy = {
  '/api': { target: 'https://workflow.j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
  '/w': { target: 'https://workflow.j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
  '/_bffless': { target: 'https://workflow.j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
}

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // The stager suite clones + builds bffless/workflow-hello over the network
    // (minutes); it has its own config and script (`test:stage`,
    // vitest.stage.config.ts) so `test:run` stays fast and network-free.
    exclude: ['**/node_modules/**', 'src/hello-stage.test.ts', 'src/hello-drift.test.ts'],
  },
})
