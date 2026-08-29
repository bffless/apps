/**
 * @vitest-environment node
 *
 * The built `dist/islands/blog-editor.html` — the same check `islands/cut-editor/build.test.ts`
 * makes of that island, for the same reasons (see its comment): ONE self-contained file that
 * already carries Studio's CSS, including the utilities Tailwind had to generate from the two
 * Studio components this island renders (`MarkdownBody`, `BlogFigure`) — sources in another
 * package, declared by `styles.css`'s `@source`s.
 *
 * Gated on the built file existing so a fresh checkout (or a `test:run` before any
 * `vite build`) doesn't fail; the stager builds every island before CI stages the bundle.
 */
import { describe, expect, it } from 'vitest'

/** A utility only Studio's `BlogFigure` uses (the Change-frame control's hover reveal). */
const FIGURE_ONLY_CLASS = '.group-hover\\:opacity-100'
/** A utility only Studio's `MarkdownBody` uses (its bulleted lists). */
const BODY_ONLY_CLASS = '.list-disc{'

type FsLike = { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string }
const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as FsLike

const file = new URL('../../dist/islands/blog-editor.html', import.meta.url).pathname

describe('dist/islands/blog-editor.html', () => {
  it.skipIf(!fs.existsSync(file))('is one self-contained file, styled by Studio', () => {
    const html = fs.readFileSync(file, 'utf8')

    // Nothing left to fetch: no external script, stylesheet or asset URL.
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i)
    expect(html).not.toMatch(/<link[^>]+\bhref=/i)
    expect(html).not.toMatch(/\b(?:src|href)="https?:/i)

    // Studio's theme tokens and component classes made it through `@import 'studio/index.css'` …
    expect(html).toContain('--color-surface:')
    expect(html).toContain('.bg-surface{')
    expect(html).toContain('.pill-ghost{')
    // … and Tailwind really scanned the two Studio components for the utilities they use.
    expect(html).toContain(FIGURE_ONLY_CLASS)
    expect(html).toContain(BODY_ONLY_CLASS)

    // `mermaid` stays out: the island renders `MarkdownBody`, not `MarkdownPreview`.
    expect(html).not.toMatch(/mermaid\.initialize/)
  })
})
