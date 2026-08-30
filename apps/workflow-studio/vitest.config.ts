/**
 * Three run environments in one config, via Vitest 4's `test.projects` (the
 * successor to a separate `vitest.workspace.ts`): `scripts/**` runs headless in a
 * Web Worker with no DOM (Node is the closest environment Vitest ships), `islands/**`
 * is React and needs `jsdom`, and `src/**` is the Node-side build tooling. `scripts/` holds
 * the workflow's six `script` modules and their suites; `islands/` holds the cut-editor
 * island and its suites (Task 23), which is why `passWithNoTests` is gone — every project
 * matches test files now.
 *
 * The `node` environment is also the RUNTIME fence behind `tsconfig.scripts.json`
 * carrying `DOM` in its `lib` for types only — a script that really reached for
 * `document` would fail here rather than at the harness.
 */
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
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
        // The stager (`scripts/stage.mjs`, Task 24) and nothing else: real Node, real
        // child processes, a real build. It cannot live in the `scripts` project — that
        // one is the Worker fence (`environment: 'node'` there exists to make a stray
        // `document` reference throw), and its files are type-checked under
        // `tsconfig.scripts.json` with `"types": []`, where `node:child_process` has no
        // types. `src/**` is type-checked under `tsconfig.node.json` instead, beside the
        // Vite configs the stager drives.
        extends: true,
        test: {
          name: 'stage',
          environment: 'node',
          include: ['src/**/*.{test,spec}.ts'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'islands',
          environment: 'jsdom',
          globals: true,
          // jest-dom's matchers, once per island suite.
          setupFiles: ['islands/test/setup.ts'],
          include: ['islands/**/*.{test,spec}.{ts,tsx}'],
        },
      },
    ],
  },
})
