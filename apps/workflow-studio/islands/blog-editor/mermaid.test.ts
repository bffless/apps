/**
 * @vitest-environment node
 *
 * The blog island's `mermaid` comes from a pinned CDN URL (see `mermaid.ts`). Two things
 * must hold: the pin is the version Studio itself depends on — `mermaid` in
 * `apps/studio/package.json`, read here the way `build.test.ts` reads the built HTML —
 * so a fence draws the same diagram in the island and in the app, and the URL points at
 * the package's ESM build, which is what a bare `import()` in the frame can execute.
 */
import { describe, expect, it } from 'vitest'
import { MERMAID_URL, MERMAID_VERSION } from './mermaid'

type FsLike = { readFileSync(p: string, enc: 'utf8'): string }
const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as FsLike

const studioManifest = new URL('../../node_modules/studio/package.json', import.meta.url).pathname

describe('the island’s mermaid pin', () => {
  it('is the version Studio depends on', () => {
    const { dependencies } = JSON.parse(fs.readFileSync(studioManifest, 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(dependencies.mermaid.replace(/^[\^~]/, '')).toBe(MERMAID_VERSION)
  })

  it('is an exact https URL to that version’s ESM build on jsDelivr', () => {
    expect(MERMAID_URL).toBe(`https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs`)
    expect(MERMAID_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
