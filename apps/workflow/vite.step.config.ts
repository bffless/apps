/**
 * The step view build (spec 10 §Islands and the run view; Phase 2 plan,
 * Decision 3): `step/index.html` → `dist/step.html`, **one self-contained
 * file**. The MCP endpoint serves it as `ui://bffless/workflow/step.html`
 * (`resources/read`), and an agent host mounts it in a sandboxed iframe with a
 * default-deny CSP — so, like an island (04), every byte it needs is inline:
 * `vite-plugin-singlefile`, the same way hello builds its islands.
 *
 * A second config rather than a second `rollupOptions.input`: the singlefile
 * plugin disables code splitting, which Rolldown refuses with multiple inputs,
 * and two entries sharing `@modelcontextprotocol/ext-apps` would emit a chunk
 * the plugin inlines into both. `emptyOutDir: false` because the main build
 * (`vite build`) has already filled `dist/`; `package.json`'s `build` runs the
 * two in that order.
 */
import { renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'dist')

/** `dist/index.html` (the step entry's own name) → `dist/step.html`, never clobbering the harness's `index.html`. */
function flattenStep(): Plugin {
  return {
    name: 'workflow:flatten-step',
    closeBundle() {
      const built = join(outDir, 'step', 'index.html')
      const target = join(outDir, 'step.html')
      rmSync(target, { force: true })
      renameSync(built, target)
      rmSync(join(outDir, 'step'), { recursive: true, force: true })
    },
  }
}

export default defineConfig({
  root: here,
  plugins: [viteSingleFile(), flattenStep()],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: { input: join(here, 'step/index.html') },
    target: 'es2022',
    modulePreload: false,
    reportCompressedSize: false,
  },
})
