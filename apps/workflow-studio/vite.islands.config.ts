/**
 * The island build for `workflow-studio` (re-rooted from `bffless/workflow-hello`'s
 * `vite.islands.config.ts`, ref 195b5a2 — see that repo for the original comments this
 * is adapted from). Studio's cut editor is a React component, so `@vitejs/plugin-react`
 * is added; hello's islands are plain DOM and didn't need it.
 *
 * An island is fetched by the harness and injected into an
 * `<iframe sandbox="allow-scripts">` as `srcdoc`, so the frame has an opaque
 * origin and **cannot fetch a sibling** — every byte the island needs has to be
 * inside the one HTML file. `vite-plugin-singlefile` is what makes that true.
 *
 * ## Why one build per island rather than two entries
 *
 * The obvious config — `rollupOptions.input` with multiple `index.html`s — does not
 * work on Vite 8: the plugin sets `output.codeSplitting = false` (Rolldown's
 * spelling of `inlineDynamicImports`), and Rolldown refuses that outright with
 * `[INVALID_OPTION] multiple inputs are not supported when
 * "output.codeSplitting" is false`. Even if it did build, two entries sharing
 * `react`/`react-dom` would emit a shared chunk that the plugin inlines into
 * *both* HTML files while deleting it from the bundle. So the (Task 24) stager
 * runs this config once per island with `WORKFLOW_ISLAND` set, and the root is
 * that island's own directory — which also means the emitted file is plain
 * `index.html` and the flattening below is a one-line rename rather than a
 * fight with Rollup's output naming.
 *
 * Env (both set by the stager, Task 24):
 * - `WORKFLOW_ISLAND`      the directory under `islands/` to build (required)
 * - `WORKFLOW_ISLANDS_OUT` where `<island>.html` lands (default `dist/islands`)
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

const island = process.env.WORKFLOW_ISLAND
if (!island || !/^[a-z0-9-]+$/.test(island)) {
  throw new Error(
    `vite.islands.config.ts: set WORKFLOW_ISLAND to an island directory under islands/ (got ${String(island)})`,
  )
}

const outDir = process.env.WORKFLOW_ISLANDS_OUT ?? resolve(here, 'dist/islands')

/** `<outDir>/index.html` → `<outDir>/<island>.html` (04: `/w/<impl>/islands/<name>.html`). */
function flattenIsland(name: string, dir: string): Plugin {
  return {
    name: 'workflow-studio:flatten-island',
    closeBundle() {
      const built = join(dir, 'index.html')
      const target = join(dir, `${name}.html`)
      rmSync(target, { force: true })
      renameSync(built, target)
    },
  }
}

export default defineConfig({
  root: join(here, 'islands', island),
  plugins: [react(), viteSingleFile(), flattenIsland(island, outDir)],
  build: {
    outDir,
    // The stager clears the directory once, before the first island: emptying
    // it per build would delete the island built just before this one.
    emptyOutDir: false,
    // The island runs in whatever browser the member is using — the same floor
    // the harness itself builds to.
    target: 'es2022',
    modulePreload: false,
    reportCompressedSize: false,
  },
})
