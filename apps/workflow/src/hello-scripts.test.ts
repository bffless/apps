/**
 * The hello bundle's `script` modules, run as modules (no Worker, no stager):
 * what `hello-src/workflows/hello/scripts/*.js` promise the workflows that call them. Cheap
 * enough to live in `test:run` — the stager suite (`hello-stage.test.ts`)
 * only proves the files get *copied*.
 *
 * `hello-src/` only exists once `pnpm --filter workflow stage` has cloned
 * `bffless/workflow-implementations` (a network call) — `describe.skipIf` skips this
 * suite cleanly rather than crashing a fresh checkout's `test:run`, and the
 * import is dynamic (a variable specifier) precisely so `tsc` never needs the
 * file to exist either.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PAYLOAD_BUDGET_BYTES, byteSize } from './lib/runner/payload'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const posterCardPath = join(appDir, 'hello-src', 'workflows', 'hello', 'scripts', 'poster-card.js')

function ctx(inputs: Record<string, unknown>) {
  return {
    inputs,
    files: { fetch: async () => new Response(null, { status: 404 }) },
    log: () => {},
    annotate: () => {},
    signal: new AbortController().signal,
  }
}

describe.skipIf(!existsSync(posterCardPath))('hello-src/workflows/hello/scripts/poster-card.js', () => {
  let posterCard: (ctx: unknown) => Promise<{ big: unknown[]; poster: unknown; posters: unknown[] }>

  beforeAll(async () => {
    const mod = await import(pathToFileURL(posterCardPath).href)
    posterCard = mod.default
  })

  it('returns a `big` output that clears the offload budget with room to spare, even for a one-character line (apps#375)', async () => {
    const out = await posterCard(ctx({ line: 'a', counts: [1] }))
    // The interactive workflow exists to exercise the `{"$file"}` offload end
    // to end, so `big` must be *comfortably* over `PAYLOAD_BUDGET_BYTES` — not
    // 1 % over, where a shorter line or a tighter serializer would silently
    // turn the demo into an inline value.
    expect(byteSize(out.big)).toBeGreaterThan(PAYLOAD_BUDGET_BYTES * 1.5)
  })

  it('returns the poster as an SVG file carrying the line', async () => {
    const out = await posterCard(ctx({ line: 'Hello <world>', counts: [1, 2] }))
    const poster = out.poster as File
    expect(poster).toBeInstanceOf(File)
    expect(poster.type).toBe('image/svg+xml')
    expect(await poster.text()).toContain('Hello &lt;world&gt;')
    expect(await poster.text()).toContain('2 lines analyzed')
  })

  // Phase 3: `posters` is what `render: images` and the `review` form's tile
  // picker read, and it must be the *same* file the `poster` output is — a
  // second, differently-drawn card would make the picker a lie.
  it('returns the same poster again as a one-item `posters` list', async () => {
    const out = await posterCard(ctx({ line: 'Hello', counts: [1] }))
    expect(out.posters).toEqual([out.poster])
  })
})
