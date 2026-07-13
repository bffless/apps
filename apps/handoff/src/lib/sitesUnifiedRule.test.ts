// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Seam C — structural guard for Sites on the unified content model
 * (structural storage, Slice 3 / issue #158). The embedded pipeline logic runs
 * only in CE's runner (validated live via MCP); this asserts the exported rule
 * set retires the manifest + the dedicated Sites route and folds Sites onto the
 * same path-passthrough content endpoint as Files:
 *
 *  - The dedicated `GET /api/sites/*` serve route is GONE.
 *  - `POST /api/sites` registers a Site at its content path prefix — no
 *    `manifest` field — storing `storage_path` (owner/repo/uploads/content/<path>)
 *    and `url` (the Entry's content URL) so its assets resolve by passthrough.
 *  - The unified `GET /api/uploads/content/*` serve loads Site nodes and
 *    authorizes a Site-internal asset (which has no node of its own) by the
 *    deepest Site whose `storage_path` prefixes the request key.
 *  - The node list / get shapes expose a Site's `url` (the stored content URL),
 *    never a `/api/sites/<id>/...` path.
 *
 * See docs/superpowers/specs/2026-07-05-structural-content-storage-design.md.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules } from '../test/proxyRules'

const NODES_SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'

const proxy = await loadProxyRules()

// Serialized backend — lets the retired-route guard below scan every rule's
// paths, step config, and embedded handler source in one pass.
const raw = JSON.stringify(proxy.rules)

const registerSite = proxy.rules.find((r) => r.pathPattern === '/api/sites' && r.method === 'POST')
const serve = proxy.rules.find((r) => r.pathPattern === '/api/uploads/content/*')
const listNodes = proxy.rules.find((r) => r.pathPattern === '/api/nodes' && r.method === 'GET')
const getNode = proxy.rules.find((r) => r.pathPattern === '/api/node' && r.method === 'GET')

describe('the dedicated Sites serve route is retired', () => {
  it('has no GET /api/sites/* rule', () => {
    const siteServe = proxy.rules.find((r) => r.pathPattern === '/api/sites/*')
    expect(siteServe).toBeUndefined()
  })

  it('no rule references a /api/sites/<id>/ serve path anywhere', () => {
    expect(raw).not.toContain('/api/sites/')
  })
})

describe('POST /api/sites registers a Site at its content path prefix (no manifest)', () => {
  it('exists as an enabled pipeline rule', () => {
    expect(registerSite).toBeTruthy()
    expect(registerSite!.proxyType).toBe('pipeline')
    expect(registerSite!.isEnabled).toBe(true)
  })

  it('carries no manifest field on the create step', () => {
    const create = registerSite!.pipelineConfig.steps.find((s: any) => s.id === 'create')
    expect(create.handlerType).toBe('data_create')
    expect(Object.keys(create.config.fields)).not.toContain('manifest')
  })

  it('computes the Site storage prefix + Entry content URL from deployment owner/repo', () => {
    const build = registerSite!.pipelineConfig.steps.find((s: any) => s.id === 'build')
    expect(build.handlerType).toBe('function_handler')
    expect(build.config.code).toContain('deployment')
    expect(build.config.code).toContain('/uploads/content/')
    expect(build.config.code).toContain('/api/uploads/content/')
  })

  it('stores the storage prefix + content URL + entry against the nodes schema', () => {
    const create = registerSite!.pipelineConfig.steps.find((s: any) => s.id === 'create')
    expect(create.config.schemaId).toBe(NODES_SCHEMA)
    expect(create.config.fields.storage_path).toBe('steps.build.storagePrefix')
    expect(create.config.fields.url).toBe('steps.build.url')
    expect(create.config.fields.siteEntry).toBe('steps.build.entry')
    expect(create.config.fields.nodeType).toBe("'site'")
  })
})

describe('the unified content serve authorizes Site-internal assets by path prefix', () => {
  it('loads Site nodes alongside Folder nodes', () => {
    const allSites = serve!.pipelineConfig.steps.find((s: any) => s.id === 'allSites')
    expect(allSites.handlerType).toBe('data_query')
    expect(allSites.config.schemaId).toBe(NODES_SCHEMA)
    expect(allSites.config.filters.nodeType.value).toBe('site')
  })

  it('resolves an asset with no node by the deepest Site whose storage_path prefixes the key', () => {
    const gate = serve!.pipelineConfig.steps.find((s: any) => s.id === 'gate')
    const code = gate.config.code as string
    expect(code).toContain('allSites')
    expect(code).toContain('storage_path')
    // Prefix match on the full request key (either exact or a `<prefix>/` child).
    expect(code).toContain("fullKey===sp||fullKey.indexOf(sp+'/')===0")
  })

  it('404s a path that resolves to neither a node nor a Site', () => {
    const deny404 = serve!.pipelineConfig.steps.find((s: any) => s.id === 'deny404')
    expect(deny404.handlerType).toBe('response_handler')
    expect(deny404.config.status).toBe(404)
    expect(deny404.config.condition).toBe('steps.gate.deny404')
  })
})

describe('node shapes expose a Site\'s stored content URL, not a /api/sites path', () => {
  it('the list + get shapes take url straight from the record', () => {
    const listShape = listNodes!.pipelineConfig.steps.find((s: any) => s.id === 'shape')
    const getShape = getNode!.pipelineConfig.steps.find((s: any) => s.id === 'shape')
    expect(listShape.config.code).not.toContain('/api/sites/')
    expect(getShape.config.code).not.toContain('/api/sites/')
  })
})
