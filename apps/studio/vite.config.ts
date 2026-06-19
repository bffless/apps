import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import https from 'node:https'

// Force a fresh upstream connection per proxied request. The dev proxy otherwise
// pools keep-alive sockets, but the Cloudflare-fronted upstream closes idle ones
// at ~5s (the `Keep-Alive: timeout=5` we see on responses). Reusing a socket
// Cloudflare just closed — far likelier under concurrent requests, e.g. the
// parallel thumbnail registers — yields an ECONNRESET that http-proxy surfaces as
// a 502 (empty text/plain body, no Cf-Ray) *before the request reaches the
// origin* (hence those attempts never appear in the pipeline logs). Disabling
// keep-alive trades a little latency for no stale-socket 502s in dev.
const upstreamAgent = new https.Agent({ keepAlive: false })

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Keep ffmpeg.wasm out of esbuild's dep pre-bundling: `@ffmpeg/ffmpeg` ships a
  // module worker it locates via `new URL('./worker.js', import.meta.url)` (which
  // optimization breaks), and `@ffmpeg/core` is the ~32 MB wasm we want emitted as
  // a plain `?url` asset, not chewed through esbuild. Lazy-loaded on first assemble.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/core', '@ffmpeg/core-mt'] },
  build: {
    // Never inline the ffmpeg core assets. Vite would otherwise base64-inline the
    // tiny core-mt pthread `worker.js` (~2 KB) as a `data:` URL, and emscripten
    // can't reliably spawn pthread workers from a data URL — the multithreaded
    // core would fail to load (and fall back to single-threaded). Forcing real
    // file URLs keeps the worker resolvable. `false` = always emit a file;
    // `undefined` = default size-based behavior for every other asset.
    assetsInlineLimit: (filePath: string) =>
      /ffmpeg-core/.test(filePath) ? false : undefined,
  },
  // NB: cross-origin isolation (COOP/COEP) is deliberately set ONLY on `preview`
  // (the production-like build), NOT the dev `server`. The multithreaded ffmpeg
  // core's `{type:"module"}` pthread-worker patch (scripts/patch-core-mt.mjs) only
  // takes effect in the BUILT asset; Vite's dev server serves the core through its
  // own transform, where the patched worker loads as a classic worker and fails.
  // So: `npm run dev` stays single-threaded (not isolated → ffmpeg.ts uses the ST
  // core, which works), and the multithreaded path is verified via `npm run
  // preview` and in production (the /studio response-header rule). Don't add
  // `server.headers` here — it re-breaks dev cutting.
  server: {
    proxy: {
      '/api': { target: 'https://j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
      '/_bffless': { target: 'https://j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    // Same upstream proxy as dev so the cut step's upload works end-to-end on the
    // preview server (where the multithreaded core is verified).
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
