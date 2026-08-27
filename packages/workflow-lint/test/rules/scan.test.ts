import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'
import { scanRuleSet, resolveRuleSet } from '../../src/rules/scan.js'
import { findRule, expectedRuleFile } from '../../src/rules/match.js'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))
const helloDir = `${fixtures}rules/hello`
const plainDir = `${fixtures}rules/plain`
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
