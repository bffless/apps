/**
 * `.bffless/skills/**` is a *copy* of `apps/studio/.bffless/skills/**` — the same three
 * skills Studio points its `thumbnail/draft`, `describe` and `blog` steps at, carried
 * here so this implementation's bundle serves them itself (#430; the rules resolve them
 * from the `workflow-studio` alias, see `scripts/stage.mjs`). This app is a PORT: where a
 * prompt or a skill came from Studio it is Studio's, verbatim (CLAUDE.md), and this is
 * the drift check — it fails the moment Studio's copy changes and this one has not been
 * refreshed, the same way `apps/workflow/src/hello-drift.test.ts` pins the spec examples
 * to `bffless/workflow-hello`.
 *
 * Studio is reached through the `studio` workspace dependency (`node_modules/studio` is
 * the symlink pnpm makes), not a `../studio` path — the dependency is the declared
 * relationship; a sibling directory is not.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const ours = join(appDir, '.bffless', 'skills')
const studios = join(appDir, 'node_modules', 'studio', '.bffless', 'skills')

/** Every file under `dir`, as paths relative to it, sorted. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(relative(dir, full))
    }
  }
  walk(dir)
  return out.sort()
}

describe.skipIf(!existsSync(studios))('.bffless/skills mirrors apps/studio/.bffless/skills', () => {
  it('carries the same files', () => {
    expect(filesUnder(ours)).toEqual(filesUnder(studios))
  })

  for (const file of existsSync(ours) ? filesUnder(ours) : []) {
    it(file, () => {
      expect(readFileSync(join(ours, file), 'utf8')).toBe(readFileSync(join(studios, file), 'utf8'))
    })
  }
})
