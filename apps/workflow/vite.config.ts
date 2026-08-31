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
    // The stager suite clones + builds bffless/workflow-implementations' hello over the network
    // (minutes); it has its own config and script (`test:stage`,
    // vitest.stage.config.ts) so `test:run` stays fast and never reaches the
    // network itself. It is not the *full* suite on a fresh checkout, though:
    // a handful of mock-backed tests (hello-scripts.test.ts,
    // mocks/analyze.fn.parity.test.ts, the "script module route" describe in
    // mocks/handlers.test.ts) read `hello-src/` — populated only by `pnpm
    // stage` — and `describe.skipIf` them out when it is absent rather than
    // failing. Run `pnpm --filter workflow stage` first for every test to
    // actually run.
    exclude: ['**/node_modules/**', 'src/hello-stage.test.ts', 'src/hello-drift.test.ts'],
  },
})
