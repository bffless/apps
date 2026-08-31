/**
 * The stager suite on its own. `hello-stage.test.ts` runs the real
 * `scripts/stage-hello.mjs` — a network clone of `bffless/workflow-implementations` at
 * `hello.ref`, its `pnpm install` and its own Vite build — so it is minutes,
 * not milliseconds, and is kept out of `test:run` (see `vite.config.ts`).
 * `hello-drift.test.ts` rides along here for the same reason: it needs the
 * `hello-src/` that staging populates. CI runs `pnpm --filter workflow
 * test:stage` as its own step after `stage`; the island glob the MSW mock
 * reads must be populated first, which is what the parity test in
 * `hello-stage.test.ts` checks.
 *
 * Not `mergeConfig`: that concatenates `include`, which would run the whole
 * unit suite here as well. Everything but the file list is the base config's.
 */
import { defineConfig } from 'vitest/config'
import base from './vite.config'

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/hello-stage.test.ts', 'src/hello-drift.test.ts'],
    exclude: ['**/node_modules/**'],
  },
})
