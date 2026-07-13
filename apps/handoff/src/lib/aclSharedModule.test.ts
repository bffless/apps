// @vitest-environment node
/**
 * The ACL module is duplicated once per rule set — guard that the copies never diverge.
 *
 * A `.fn.ts` handler may only import paths CONFINED TO ITS OWN RULE SET DIRECTORY (the bundler
 * rejects anything that escapes, including a symlink out). Handoff ships two sets — `handoff` (the
 * app API) and `handoff-rss-feed` (the public feeds) — and gates access in both, so `_shared/acl.ts`
 * has to physically exist in each. That is a duplication the platform forces on us, and duplication
 * that nothing checks is duplication that drifts: a fix to the `handoff` copy that misses the feed
 * copy would silently make the feeds' access rules disagree with the API's — exactly the class of
 * bug the shared module was extracted to kill.
 *
 * So: byte-identical, or fail.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SETS = ['handoff', 'handoff-rss-feed'] as const

const aclSource = (set: string) =>
  readFileSync(new URL(`../../.bffless/proxy-rules/${set}/_shared/acl.ts`, import.meta.url), 'utf8')

describe('_shared/acl.ts is identical across Handoff’s rule sets', () => {
  it('every set ships the same ACL module, byte for byte', () => {
    const [first, ...rest] = SETS.map((set) => ({ set, source: aclSource(set) }))
    for (const other of rest) {
      expect(
        other.source,
        `_shared/acl.ts differs between "${first.set}" and "${other.set}" — the access rules of the ` +
          `two sets have drifted apart. Copy the corrected file to both.`,
      ).toBe(first.source)
    }
  })

  it('the module still exports the primitives every gate depends on', () => {
    for (const set of SETS) {
      const source = aclSource(set)
      for (const symbol of ['evalAccess', 'folderChain', 'rank', 'idOf', 'ANYONE_PRINCIPAL']) {
        expect(source, `${set}/_shared/acl.ts is missing ${symbol}`).toContain(symbol)
      }
    }
  })
})
