/**
 * `src/prepare.ts` — the ported `prepare-rules.mjs` (apps#420, plan Decision
 * 8: docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:24). Cases
 * ported from `bffless/publish-workflow` `test/prepare-rules.test.mjs`
 * (fetched read-only, not re-typed from memory), run against this package's
 * own `test/fixtures/hello-tree/.bffless/proxy-rules/hello` (Phase 1's
 * fixture) instead of publish-workflow's own tiny `test/fixtures/hello` —
 * the assertions are the same shape (`ruleset.yaml`'s `name:` renamed, the
 * generated forwarder's exact fields, the source tree untouched), compared
 * yaml-normalized (parsed then deep-equal) rather than byte-for-byte, since
 * the two fixture trees' `ruleset.yaml`/rule content genuinely differ.
 *
 * `prepareRules` never writes into `rulesDir` — every test here reads the
 * checked-in fixture directly, no `freshCopy()` needed (unlike
 * rewrite.test.ts/rename.test.ts, which mutate in place).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, test } from 'vitest'
import { assertAlias, assertDisjoint, assertTargetUrl, prepareRules } from '../src/prepare.js'
import { ALIAS_RE, RESERVED_ALIASES } from '../src/rewrite.js'

const rulesDir = fileURLToPath(new URL('./fixtures/hello-tree/.bffless/proxy-rules/hello', import.meta.url))
const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'workflow-cli-prepare-')), 'rules')
const readYaml = (p: string): unknown => parse(readFileSync(p, 'utf8'))

describe('prepareRules', () => {
  test('copies the set, renames it, writes the forwarder — yaml-normalized against the action fixture shape', () => {
    const out = prepareRules({
      rulesDir,
      alias: 'hello-pr-3',
      targetUrl: 'https://hello-pr-3.example.test',
      outDir: tmp(),
    })

    const ruleset = readYaml(join(out, 'ruleset.yaml')) as { name: string }
    expect(ruleset.name).toBe('hello-pr-3')

    const { description, ...fwd } = readYaml(join(out, 'rules/_custom/forward/get.rule.yaml')) as {
      pathPattern: string
      targetUrl: string
      forwardCookies: boolean
      headerConfig: { forward: string[]; strip: string[] }
      order: number
      description: string
    }
    expect(fwd).toEqual({
      pathPattern: '/w/hello-pr-3/*',
      targetUrl: 'https://hello-pr-3.example.test',
      forwardCookies: true,
      headerConfig: {
        forward: ['accept', 'accept-language', 'content-type', 'user-agent', 'x-request-id', 'cookie', 'authorization'],
        strip: ['host', 'connection', 'keep-alive', 'transfer-encoding'],
      },
      order: 5,
    })
    expect(description).toMatch(/hello-pr-3/)

    expect(existsSync(join(out, 'rules/echo/post/rule.yaml'))).toBe(true)
  })

  test('leaves the source set untouched', () => {
    prepareRules({ rulesDir, alias: 'hello-pr-4', targetUrl: 'https://x.example.test', outDir: tmp() })
    expect((readYaml(join(rulesDir, 'ruleset.yaml')) as { name: string }).name).toBe('hello')
    expect(existsSync(join(rulesDir, 'rules/_custom'))).toBe(false)
  })

  test('refuses an authored forwarder (it is generated)', () => {
    // A fresh copy of the fixture with a hand-authored forwarder planted —
    // the real fixture never carries one, so this is synthesized on the fly
    // rather than added as a checked-in fixture.
    const withForwarder = mktempCopyWithForwarder()
    expect(() => prepareRules({ rulesDir: withForwarder, alias: 'x', targetUrl: 'https://x.example.test', outDir: tmp() })).toThrow(
      /rules\/_custom\/forward/,
    )
  })

  test('rejects a malformed alias', () => {
    expect(() => prepareRules({ rulesDir, alias: 'Hello_3', targetUrl: 'https://x.example.test', outDir: tmp() })).toThrow(/alias/i)
  })

  test('rejects a reserved alias', () => {
    for (const alias of RESERVED_ALIASES) {
      expect(() => prepareRules({ rulesDir, alias, targetUrl: 'https://x.example.test', outDir: tmp() })).toThrow(/reserved/i)
    }
  })

  test('requires a target url', () => {
    expect(() => prepareRules({ rulesDir, alias: 'hello', targetUrl: '', outDir: tmp() })).toThrow(/target-url/)
  })

  test('rejects a target url that is not an absolute http(s) URL', () => {
    for (const targetUrl of ['hello.example.test', '/w/hello', 'ftp://hello.example.test', 'javascript:alert(1)']) {
      expect(() => prepareRules({ rulesDir, alias: 'hello', targetUrl, outDir: tmp() })).toThrow(/target-url/)
    }
  })

  test('accepts an http target url', () => {
    const out = prepareRules({ rulesDir, alias: 'hello', targetUrl: 'http://localhost:5173', outDir: tmp() })
    expect((readYaml(join(out, 'rules/_custom/forward/get.rule.yaml')) as { targetUrl: string }).targetUrl).toBe(
      'http://localhost:5173',
    )
  })

  test('a re-run replaces the staged set instead of merging into it', () => {
    const outDir = tmp()
    const first = prepareRules({ rulesDir, alias: 'hello', targetUrl: 'https://hello.example.test', outDir })
    // A stale artefact from an earlier run of a *different* set must not survive.
    writeFileSync(join(first, 'rules', 'stale.rule.yaml'), 'pathPattern: /stale\n')
    prepareRules({ rulesDir, alias: 'hello', targetUrl: 'https://hello.example.test', outDir })
    expect(existsSync(join(outDir, 'rules', 'stale.rule.yaml'))).toBe(false)
    expect(existsSync(join(outDir, 'rules', '_custom', 'forward', 'get.rule.yaml'))).toBe(true)
  })

  test('refuses to stage into the rule set directory itself', () => {
    // A COPY of the fixture: if this guard ever regresses, the regression
    // eats the copy, not the checked-in fixture.
    const copyDir = join(tmp(), 'hello')
    cpSync(rulesDir, copyDir, { recursive: true })

    for (const outDir of [copyDir, join(copyDir, 'staged'), dirname(copyDir)]) {
      expect(() => prepareRules({ rulesDir: copyDir, alias: 'hello', targetUrl: 'https://x.example.test', outDir })).toThrow(/--out/)
    }
    expect(existsSync(join(copyDir, 'ruleset.yaml'))).toBe(true)
  })

  test('requires an out directory', () => {
    expect(() => prepareRules({ rulesDir, alias: 'hello', targetUrl: 'https://x.example.test', outDir: '' })).toThrow(
      /--out is required/,
    )
  })

  test('fails when the rule set directory is not a rule set', () => {
    expect(() =>
      prepareRules({ rulesDir: join(dirname(rulesDir), 'nope'), alias: 'hello', targetUrl: 'https://x.example.test', outDir: tmp() }),
    ).toThrow(/ruleset\.yaml/)
  })
})

describe('exported guards, usable standalone', () => {
  test('assertAlias reuses ../rewrite.js\'s ALIAS_RE/RESERVED_ALIASES (not redeclared)', () => {
    expect(() => assertAlias('workflow')).toThrow(new RegExp(RESERVED_ALIASES.join('|')))
    expect(() => assertAlias('Hello!')).toThrow(new RegExp(ALIAS_RE.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    expect(() => assertAlias('hello')).not.toThrow()
  })

  test('assertTargetUrl', () => {
    expect(() => assertTargetUrl(undefined)).toThrow(/target-url/)
    expect(() => assertTargetUrl('https://x.example.test')).not.toThrow()
  })

  test('assertDisjoint', () => {
    expect(() => assertDisjoint(rulesDir, undefined)).toThrow(/--out is required/)
    expect(() => assertDisjoint(rulesDir, rulesDir)).toThrow(/overlaps/)
    expect(() => assertDisjoint(rulesDir, tmp())).not.toThrow()
  })
})

/** A temp copy of the hello-tree rule set with a hand-authored `rules/_custom/forward/get.rule.yaml` planted. */
function mktempCopyWithForwarder(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'workflow-cli-prepare-src-')), 'hello')
  cpSync(rulesDir, dir, { recursive: true })
  const forwardDir = join(dir, 'rules', '_custom', 'forward')
  mkdirSync(forwardDir, { recursive: true })
  writeFileSync(join(forwardDir, 'get.rule.yaml'), 'pathPattern: /w/mine/*\ntargetUrl: https://mine.example.test\nforwardCookies: true\norder: 5\n')
  return dir
}
