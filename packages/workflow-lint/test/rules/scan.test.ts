import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'
import { scanRuleSet, resolveRuleSet } from '../../src/rules/scan.js'
import { findRule, expectedRuleFile, resolveUrl } from '../../src/rules/match.js'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))
const helloDir = `${fixtures}rules/hello`
const plainDir = `${fixtures}rules/plain`
const bareDir = `${fixtures}rules/bare`
const impl = (rel: string) => `${fixtures}impl/${rel}`

test('scanRuleSet reads the alias from ruleset.yaml and indexes every rule', () => {
  const index = scanRuleSet(helloDir)
  expect(index.alias).toBe('hello')
  expect(index.prefix).toBe('/api/hello')
  expect(index.rules.map((r) => `${r.methods?.join('|') ?? 'ANY'} ${r.pattern}`).sort()).toEqual([
    'GET /api/hello/job',
    'GET /api/hello/wild/*',
    'GET /w/hello/*',
    'POST /api/hello/echo',
  ])
})

test('a set authored with no alias segment reports the bare /api prefix (post-M3)', () => {
  const index = scanRuleSet(plainDir)
  expect(index.alias).toBe('plain')
  expect(index.prefix).toBe('/api')
  expect(findRule(index, '/api/echo', 'POST')).toBeTruthy()
})

test('a pathPrefix set means the URL prefix is the flag and the layout is bare', () => {
  const index = scanRuleSet(bareDir, { alias: 'hello', pathPrefix: '/api/hello' })
  expect(index.prefix).toBe('/api/hello')
  expect(index.layout).toBe('')
  expect(resolveUrl(index, 'echo')).toBe('/api/hello/echo')
  expect(expectedRuleFile(index, 'echo', 'POST')).toBe('rules/echo/post/rule.yaml')
  expect(findRule(index, '/api/hello/echo', 'POST')?.source).toBe('rules/echo/post/rule.yaml')
})

test('the index records the given --path-prefix, so checks can validate the flag itself', () => {
  expect(scanRuleSet(bareDir, { alias: 'hello', pathPrefix: '/api/hello' }).pathPrefix).toBe('/api/hello')
  expect(scanRuleSet(helloDir).pathPrefix).toBeUndefined()
})

test('without a pathPrefix the layout is the prefix — the hand-authored shape is unchanged', () => {
  expect(scanRuleSet(helloDir).layout).toBe('/api/hello')
  expect(scanRuleSet(plainDir).layout).toBe('/api')
})

test('an explicit pathPattern is verbatim — the prefix is only added to derived patterns', () => {
  const index = scanRuleSet(bareDir, { pathPrefix: '/api/hello' })
  expect(findRule(index, '/w/bare/anything', 'GET')?.source).toBe('rules/share/get.rule.yaml')
  expect(findRule(index, '/api/hello/w/bare/anything', 'GET')).toBeUndefined()
})

test('resolveRuleSet threads --path-prefix through to the scan', () => {
  const ctx = resolveRuleSet({ rulesDir: bareDir, pathPrefix: '/api/hello' })
  expect(ctx.found).toBe(true)
  if (ctx.found) {
    expect(ctx.prefix).toBe('/api/hello')
    expect(ctx.layout).toBe('')
  }
})

test('findRule matches on path and method, and honours wildcards', () => {
  const index = scanRuleSet(helloDir)
  expect(findRule(index, '/api/hello/echo', 'POST')?.source).toBe('rules/api/hello/echo/post/rule.yaml')
  expect(findRule(index, '/api/hello/echo', 'GET')).toBeUndefined()
  expect(findRule(index, '/api/hello/job', 'GET')?.source).toBe('rules/api/hello/job/get/rule.yaml')
  expect(findRule(index, '/api/hello/nope', 'POST')).toBeUndefined()
  expect(findRule(index, '/api/hello/wild/a/b', 'GET')).toBeTruthy()
})

test('expectedRuleFile names the directory the author has to add', () => {
  const index = scanRuleSet(helloDir)
  expect(expectedRuleFile(index, 'echoo', 'POST')).toBe('rules/api/hello/echoo/post/rule.yaml')
  expect(expectedRuleFile(scanRuleSet(plainDir), 'echo', 'GET')).toBe('rules/api/echo/get/rule.yaml')
})

test('resolveRuleSet walks up to the single .bffless/proxy-rules set beside the workflow', () => {
  const ctx = resolveRuleSet({ file: impl('.bffless/workflows/solo.workflow.yaml') })
  expect(ctx.found).toBe(true)
  if (ctx.found) {
    expect(ctx.alias).toBe('solo')
    expect(ctx.prefix).toBe('/api/solo')
    expect(findRule(ctx, '/api/solo/ping', 'POST')).toBeTruthy()
  }
})

test('resolveRuleSet is unresolved (not an error) when there is no .bffless above the file', () => {
  const ctx = resolveRuleSet({ file: `${fixtures}rules/plain/rules/api/echo/post/rule.yaml` })
  expect(ctx.found).toBe(false)
  if (!ctx.found) expect(ctx.reason).toMatch(/\.bffless\/proxy-rules/)
})

test('resolveRuleSet honours an explicit --rules dir', () => {
  const ctx = resolveRuleSet({ rulesDir: helloDir })
  expect(ctx.found).toBe(true)
  if (ctx.found) expect(ctx.alias).toBe('hello')
})

test('several sets under one .bffless are ambiguous until --alias picks one', () => {
  const file = `${fixtures}multi/.bffless/workflows/multi.workflow.yaml`
  const ambiguous = resolveRuleSet({ file })
  expect(ambiguous.found).toBe(false)
  if (!ambiguous.found) expect(ambiguous.reason).toMatch(/alpha, beta/)

  const picked = resolveRuleSet({ file, alias: 'beta' })
  expect(picked.found).toBe(true)
  if (picked.found) {
    expect(picked.prefix).toBe('/api/beta')
    expect(findRule(picked, '/api/beta/ping', 'POST')).toBeTruthy()
  }
})

test('resolveRuleSet reports a missing directory instead of throwing', () => {
  const ctx = resolveRuleSet({ rulesDir: `${fixtures}rules/nope` })
  expect(ctx.found).toBe(false)
  if (!ctx.found) expect(ctx.reason).toMatch(/nope/)
})
