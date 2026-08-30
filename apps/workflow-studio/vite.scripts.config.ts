/**
 * The `script`-step build for `workflow-studio`. A script runs inside a Web Worker on
 * an opaque origin (spec 03/09): the harness fetches the module's text and hands it to
 * a hidden sandboxed iframe, which spawns the Worker from a `data:` URL — so, like the
 * islands (`vite.islands.config.ts`), the module has to be self-contained. Library mode
 * with `inlineDynamicImports: true` gets there without `vite-plugin-singlefile` (that
 * plugin only inlines into HTML): one entry per build, one flat `.js` file out.
 *
 * Why one build per script rather than one multi-entry build: sharing a build across
 * scripts would let Rollup split a common chunk out (workflow-hello's islands hit the
 * exact same wall the other way — see `vite.islands.config.ts`) and `inlineDynamicImports`
 * refuses multiple entries for the same reason. `fileName` drops any extension so the
 * emitted name matches what the workflow YAML's `script.module` and `index.json`'s
 * `scripts[]` list (Task 22).
 *
 * Env (both set by the stager, Task 24):
 * - `WORKFLOW_SCRIPT`      the entry module under `scripts/` to build (required)
 * - `WORKFLOW_SCRIPTS_OUT` where `<name>.js` lands (default `dist/scripts`)
 */
import { defineConfig } from 'vite'
import { basename, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const entry = process.env.WORKFLOW_SCRIPT
// A path (`scripts/<name>.ts`, what the stager passes), unlike WORKFLOW_ISLAND's bare
// directory name — so the shape check is path-aware where the islands config's is not.
if (!entry || !/^scripts\/[a-z0-9-]+\.ts$/.test(entry)) {
  throw new Error(
    `vite.scripts.config.ts: set WORKFLOW_SCRIPT to an entry file under scripts/ (got ${String(entry)})`,
  )
}

const outDir = process.env.WORKFLOW_SCRIPTS_OUT ?? resolve(here, 'dist/scripts')
const name = basename(entry, extname(entry))

export default defineConfig({
  build: {
    outDir,
    // The stager clears the directory once, before the first script: emptying
    // it per build would delete the script built just before this one.
    emptyOutDir: false,
    // The floor a Worker on the member's browser runs — same as the islands.
    target: 'es2022',
    lib: {
      entry: resolve(here, entry),
      formats: ['es'],
      fileName: () => `${name}.js`,
    },
    rollupOptions: {
      output: {
        // No sibling chunks: the module is imported verbatim into a `data:` URL
        // (03), so every byte it needs must be inlined into the one file.
        inlineDynamicImports: true,
      },
    },
    reportCompressedSize: false,
  },
})
