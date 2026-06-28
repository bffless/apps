// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard for the public (no-auth) serve + toggle rules
 * (issue #57). The embedded-JS logic runs only in CE's pipeline runner; this
 * asserts the rules are present and wired the way the spec requires:
 *
 *  - GET  /api/public/content/*  reverse-proxies a file's bytes through the
 *    file server (file_serve_handler, NOT a presigned bucket URL) and only when
 *    the node is explicitly flagged `public`.
 *  - POST /api/public           owner/admin toggles a node's `public` flag.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const NODES_SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

const serve = proxy.rules.find((r) => r.pathPattern === '/api/public/content/*')
const toggle = proxy.rules.find((r) => r.pathPattern === '/api/public')

describe('handoff public serve rule (GET /api/public/content/*)', () => {
  it('exists as an enabled GET pipeline rule', () => {
    expect(serve).toBeTruthy()
    expect(serve!.proxyType).toBe('pipeline')
    expect(serve!.isEnabled).toBe(true)
    expect(serve!.method).toBe('GET')
  })

  it('has the expected pipeline steps in order', () => {
    const ids = serve!.pipelineConfig.steps.map((s: any) => s.id)
    expect(ids).toEqual(['parsePath', 'nodeByKey', 'publicGate', 'serve', 'notPublic'])
  })

  it('resolves the node by storage_path with the nodes schema', () => {
    const node = serve!.pipelineConfig.steps.find((s: any) => s.id === 'nodeByKey')
    expect(node.handlerType).toBe('data_query')
    expect(node.config.schemaId).toBe(NODES_SCHEMA)
    expect(node.config.filters.storage_path.value).toBe('steps.parsePath.fullKey')
  })

  it('streams bytes through the file server — never a presigned bucket URL', () => {
    const types = serve!.pipelineConfig.steps.map((s: any) => s.handlerType)
    expect(types).toContain('file_serve_handler')
    // The bucket must stay private: no signed_url / presigned step on this path.
    expect(types).not.toContain('signed_url')
    const fileServe = serve!.pipelineConfig.steps.find((s: any) => s.id === 'serve')
    expect(fileServe.config.subDir).toBe('content')
    expect(fileServe.config.condition).toBe('steps.publicGate.allow')
  })

  it('gates strictly on the explicit public flag and a size ceiling', () => {
    const gate = serve!.pipelineConfig.steps.find((s: any) => s.id === 'publicGate')
    expect(gate.handlerType).toBe('function_handler')
    expect(gate.config.code).toContain('public')
    // opt-in only: the flag must be checked, not assumed
    expect(gate.config.code).toContain("=== true")
    // size ceiling present (10 MB)
    expect(gate.config.code).toContain('10485760')
  })

  it('404s (does not leak existence) when the node is not public', () => {
    const deny = serve!.pipelineConfig.steps.find((s: any) => s.id === 'notPublic')
    expect(deny.handlerType).toBe('response_handler')
    expect(deny.config.status).toBe(404)
    expect(deny.config.condition).toBe('steps.publicGate.deny')
  })
})

describe('handoff public toggle rule (POST /api/public)', () => {
  it('exists as an enabled POST pipeline rule', () => {
    expect(toggle).toBeTruthy()
    expect(toggle!.proxyType).toBe('pipeline')
    expect(toggle!.isEnabled).toBe(true)
    expect(toggle!.method).toBe('POST')
  })

  it('requires auth and allows an API key (so CI/agents can publish)', () => {
    const validators = toggle!.pipelineConfig.validators ?? []
    const auth = validators.find((v: any) => v.type === 'auth_required')
    expect(auth).toBeTruthy()
    expect(auth.config.allowApiKey).toBe(true)
  })

  it('has the expected pipeline steps in order', () => {
    const ids = toggle!.pipelineConfig.steps.map((s: any) => s.id)
    expect(ids).toEqual(['pre', 'node', 'check', 'update', 'shape', 'ok', 'denied'])
  })

  it('updates the node record public flag, gated on ownership', () => {
    const update = toggle!.pipelineConfig.steps.find((s: any) => s.id === 'update')
    expect(update.handlerType).toBe('data_update')
    expect(update.config.schemaId).toBe(NODES_SCHEMA)
    expect(update.config.recordId).toBe('steps.pre.id')
    expect(update.config.fields.public).toBe('steps.pre.makePublic')
    expect(update.config.condition).toBe('steps.check.allowed')
  })

  it('only the node owner or an admin may toggle', () => {
    const check = toggle!.pipelineConfig.steps.find((s: any) => s.id === 'check')
    expect(check.handlerType).toBe('function_handler')
    expect(check.config.code).toContain('isOwner')
    expect(check.config.code).toContain('isAdmin')
  })

  it('returns 403 when not allowed', () => {
    const denied = toggle!.pipelineConfig.steps.find((s: any) => s.id === 'denied')
    expect(denied.config.status).toBe(403)
    expect(denied.config.condition).toBe('steps.check.denied')
  })
})
