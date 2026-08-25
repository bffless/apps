/**
 * The stager suite on its own. `hello-stage.test.ts` runs the real
 * `scripts/stage-hello.mjs` — a `tsc` pass over the islands plus one Vite build
 * per island — so it is minutes, not milliseconds, and is kept out of
 * `test:run` (see `vite.config.ts`). CI runs `pnpm --filter workflow test:stage`
 * as its own step after `stage`; the island glob the MSW mock reads must be
 * populated first, which is what the parity test in that file checks.
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
    include: ['src/hello-stage.test.ts'],
    exclude: ['**/node_modules/**'],
  },
})
