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
  },
})
