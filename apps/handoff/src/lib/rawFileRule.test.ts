// @vitest-environment node
/**
 * Structural guard for the /r raw-file proxy rule. The embedded-JS logic runs
 * only in CE's pipeline runner (validated live in Task 3); this asserts the
 * rule is present and wired the way the spec requires.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

const rule = proxy.rules.find((r) => r.pathPattern === '/r/*' && r.method === 'GET')

describe('handoff /r raw-file proxy rule', () => {
  it('exists as an enabled pipeline rule', () => {
    expect(rule).toBeTruthy()
    expect(rule!.proxyType).toBe('pipeline')
    expect(rule!.isEnabled).toBe(true)
  })

  it('has the expected pipeline steps in order', () => {
    const ids = rule!.pipelineConfig.steps.map((s: any) => s.id)
    expect(ids).toEqual(['parse', 'link', 'node', 'folders', 'check', 'sign', 'ok', 'bad'])
  })

  it('looks up the share link and node with the known schema ids', () => {
    const link = rule!.pipelineConfig.steps.find((s: any) => s.id === 'link')
    const node = rule!.pipelineConfig.steps.find((s: any) => s.id === 'node')
    expect(link.config.schemaId).toBe('ace1febf-4b3d-4a11-a5f8-22a056dd9afa')
    expect(link.config.recordId).toBe('steps.parse.token')
    expect(node.config.schemaId).toBe('1c5d4802-596e-4f50-a08f-c41fb8f9fab0')
    expect(node.config.recordId).toBe('steps.parse.fileId')
  })

  it('signs only when allowed, with a 300s TTL on the check storagePath', () => {
    const sign = rule!.pipelineConfig.steps.find((s: any) => s.id === 'sign')
    expect(sign.handlerType).toBe('signed_url')
    expect(sign.config.condition).toBe('steps.check.allow')
    expect(sign.config.path).toBe('steps.check.storagePath')
    expect(sign.config.expiresIn).toBe('300')
  })

  it('302s to the presigned Location on allow, 404 on deny', () => {
    const ok = rule!.pipelineConfig.steps.find((s: any) => s.id === 'ok')
    const bad = rule!.pipelineConfig.steps.find((s: any) => s.id === 'bad')
    expect(ok.config.status).toBe(302)
    expect(ok.config.headers.Location).toBe('{{steps.sign.url}}')
    expect(ok.config.condition).toBe('steps.check.allow')
    expect(bad.config.status).toBe(404)
    expect(bad.config.condition).toBe('steps.check.deny')
  })

  it('the check step enforces the folder-chain membership (folderChain present)', () => {
    const check = rule!.pipelineConfig.steps.find((s: any) => s.id === 'check')
    expect(check.handlerType).toBe('function_handler')
    expect(check.config.code).toContain('function folderChain')
    expect(check.config.code).toContain('inFolder')
  })
})
