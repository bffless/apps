/**
 * @vitest-environment node
 *
 * This one file in the `islands` project runs under `node`, not `jsdom`: it inspects a
 * BUILT ARTEFACT rather than rendering anything, and under jsdom `import.meta.url` is
 * `http://localhost:3000/…` (jsdom's document base), so the path to `dist/` can't be
 * derived from it. The rest of the project stays jsdom — this is a per-file override.
 *
 * What `vite.islands.config.ts` must produce for this island: ONE self-contained HTML
 * file that already carries Studio's CSS.
 *
 * The harness injects the file as `srcdoc` into an `<iframe sandbox="allow-scripts">`,
 * so the frame's origin is opaque and it can fetch NOTHING — a surviving
 * `<script src>` or `<link href>` would silently never load. And because `CutEditor`'s
 * styling is Tailwind utilities over Studio's `@theme` tokens, generated from sources
 * in another package, "the CSS is inlined" is not enough: the utilities have to have
 * been generated at all (`styles.css`'s `@source`), which is what `SHEET_ONLY_CLASS`
 * checks — a class that appears in `CutEditor.tsx` and nowhere in this app.
 *
 * Gated on the built file existing so a fresh checkout (or a `test:run` before any
 * `vite build`) doesn't fail; Task 24's stager builds the islands before CI stages the
 * bundle. `scripts/build.test.ts` is the same shape for the script entries.
 */
import { describe, expect, it } from 'vitest'

/** A utility only Studio's `CutEditor` uses (its search field's `min-w-48`). */
const STUDIO_ONLY_CLASS = '.min-w-48{'

/**
 * `node:fs` through a COMPUTED specifier, so `tsconfig.islands.json` can keep its
 * browser-only `types` and an island module still can't type-check against
 * `process`/`Buffer` (`scripts/build.test.ts` dodges the same way).
 */
type FsLike = { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string }
const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as FsLike

const file = new URL('../../dist/islands/cut-editor.html', import.meta.url).pathname

describe('dist/islands/cut-editor.html', () => {
  it.skipIf(!fs.existsSync(file))('is one self-contained file, styled by Studio', () => {
    const html = fs.readFileSync(file, 'utf8')

    // Nothing left to fetch: no external script, stylesheet or asset URL.
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i)
    expect(html).not.toMatch(/<link[^>]+\bhref=/i)
    expect(html).not.toMatch(/\b(?:src|href)="https?:/i)

    // Studio's theme tokens made it through `@import 'studio/index.css'` …
    expect(html).toContain('--color-surface:')
    expect(html).toContain('.bg-surface{')
    expect(html).toContain('.rule{')
    // … and Tailwind really scanned `CutEditor.tsx` for the utilities it uses.
    expect(html).toContain(STUDIO_ONLY_CLASS)
  })
})
