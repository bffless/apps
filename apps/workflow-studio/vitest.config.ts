/**
 * Two run environments in one config, via Vitest 4's `test.projects` (the
 * successor to a separate `vitest.workspace.ts`): `scripts/**` runs headless in a
 * Web Worker with no DOM (Node is the closest environment Vitest ships), `islands/**`
 * is React and needs `jsdom`. Neither directory exists yet (Tasks 22/23 add them), so
 * both projects currently match zero files — `vitest run` passes with 0 tests, which
 * is expected for this scaffold task.
 */
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    // Neither `scripts/` nor `islands/` exists yet (Tasks 22/23) — a clean scaffold
    // checkout has zero matching test files in both projects. `passWithNoTests` is a
    // root-only option (Vitest's `NonProjectOptions`), so it has to live here rather
    // than on either project's own `test` block.
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.{test,spec}.ts'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'islands',
          environment: 'jsdom',
          globals: true,
          include: ['islands/**/*.{test,spec}.{ts,tsx}'],
        },
      },
    ],
  },
})
