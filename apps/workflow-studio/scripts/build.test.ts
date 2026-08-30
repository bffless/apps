/**
 * What `vite.scripts.config.ts` must produce for each of the five entries: ONE
 * self-contained ES module per script. The harness fetches a script's text and
 * spawns a Worker from a `data:` URL (spec 03/09) — a surviving `import` would
 * resolve against that opaque origin and fail at run time, and a sibling chunk
 * would never be fetched at all.
 *
 * Gated on the built file existing so a fresh checkout (or a `test:run` before any
 * `vite build`) doesn't fail; Task 24's stager builds all five before CI stages the
 * bundle.
 */
import { describe, expect, it } from 'vitest'

/** The five entries the workflow YAML's `script` steps name (`src: scripts/<name>.js`). */
const SCRIPT_NAMES = ['sheet-plan', 'scene-inputs', 'final-script', 'frame-times', 'blog-bundle']

/**
 * `node:fs` through a COMPUTED specifier, so `tsconfig.scripts.json` can keep
 * `"types": []` and a script module still can't type-check against `process`/`Buffer`
 * (apps/workflow/src/hello-scripts.test.ts dodges a missing file the same way). The
 * path comes off `import.meta.url` rather than the cwd so it holds however vitest is
 * invoked.
 */
type FsLike = { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string }
const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as FsLike

const built = (name: string) => new URL(`../dist/scripts/${name}.js`, import.meta.url).pathname

describe.each(SCRIPT_NAMES)('dist/scripts/%s.js', (name) => {
  const file = built(name)

  it.skipIf(!fs.existsSync(file))('is one self-contained ES module with a default export', () => {
    const code = fs.readFileSync(file, 'utf8')
    // Nothing left to resolve: no static `import`/`from`, no `import(...)`, no `require(...)`.
    // String/template literals are blanked first — `import` inside a bundled literal is
    // data, not syntax (same expression as scripts/stage.mjs; src/stage.test.ts fences it).
    const syntax = code.replace(/'(?:[^'\\\n]|\\[\s\S])*'|"(?:[^"\\\n]|\\[\s\S])*"|`(?:[^`\\]|\\[\s\S])*`/g, '""')
    expect(syntax).not.toMatch(/(^|[\s;}])import\s*[({'"*]/)
    expect(syntax).not.toMatch(/(^|[\s;}])from\s*['"]/)
    expect(syntax).not.toMatch(/[^\w.]require\s*\(/)
    expect(code).toMatch(/export\s*\{[^}]*\bas default\b|export\s+default\b/)
  })
})
