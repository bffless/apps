import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import https from 'node:https'

// Force a fresh upstream connection per proxied request. The dev proxy otherwise
// pools keep-alive sockets, but the Cloudflare-fronted upstream closes idle ones
// at ~5s (the `Keep-Alive: timeout=5` we see on responses). Reusing a socket
// Cloudflare just closed — far likelier under concurrent requests — yields an
// ECONNRESET that http-proxy surfaces as a 502. Disabling keep-alive trades a
// little latency for no stale-socket 502s in dev.
const upstreamAgent = new https.Agent({ keepAlive: false })

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'https://j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
      '/_bffless': { target: 'https://j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
    },
  },
  preview: {
    proxy: {
      '/api': { target: 'https://j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
      '/_bffless': { target: 'https://j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/main.tsx', 'src/test/**'],
    },
  },
})
