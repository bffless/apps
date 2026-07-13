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
import { loadProxyRules, handlerOf } from '../test/proxyRules'

const NODES_SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'

const proxy = await loadProxyRules()

const registerSite = proxy.rules.find((r) => r.pathPattern === '/api/sites' && r.method === 'POST')
const serve = proxy.rules.find((r) => r.pathPattern === '/api/uploads/content/*')
const listNodes = proxy.rules.find((r) => r.pathPattern === '/api/nodes' && r.method === 'GET')
const getNode = proxy.rules.find((r) => r.pathPattern === '/api/node' && r.method === 'GET')

describe('the dedicated Sites serve route is retired', () => {
  it('has no GET /api/sites/* rule', () => {
    const siteServe = proxy.rules.find((r) => r.pathPattern === '/api/sites/*')
    expect(siteServe).toBeUndefined()
  })

  it('no rule serves under /api/sites/<id>/ — POST /api/sites is the only Sites route left', () => {
    // (1) Routing: nothing under /api/sites/ is routed at all. The registrar is the exact path.
    const sitePaths = proxy.rules
      .map((r) => r.pathPattern)
      .filter((p) => p === '/api/sites' || p.startsWith('/api/sites/'))
    expect(sitePaths).toEqual(['/api/sites'])

    // (2) Config: no target URL, template, or step config names the retired route either.
    // Handler CODE is deliberately excluded — esbuild prefixes each bundled module with a
    // `// <source path>` comment, so the registrar's own bundle contains the literal text
    // "rules/api/sites/post/build.fn.ts". That substring is a build artifact of where the
    // file lives, not a resurrected route; scanning raw bundle text for it is a false positive.
    const config = JSON.stringify(proxy.rules, (k, v) => (k === 'code' ? undefined : v))
    expect(config).not.toContain('/api/sites/')

    // (3) Runtime: the registrar builds the Site's URL under the unified content endpoint.
    // This is the assertion that would actually catch a Sites-serve URL coming back to life.
    const build = handlerOf(registerSite!, 'build')
    const out = build({
      request: { body: { path: 'proto', entry: 'index.html' } },
      deployment: { owner: 'bffless', repo: 'apps' },
    })
    expect(out.url).toBe('/api/uploads/content/proto/index.html')
    expect(out.storagePrefix).toBe('bffless/apps/uploads/content/proto')
    expect(JSON.stringify(out)).not.toContain('/api/sites/')
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
    // A Site is ONE node but many objects (index.html, assets/…), so a site-internal asset has
    // no node row of its own: the gate authorizes it by the Site whose storage_path is the
    // LONGEST prefix of the key. Two nested sites with different owners make that observable —
    // if the shallower one won, `alice` would be let in and `bob` refused. Exactly inverted.
    const gate = handlerOf(serve!, 'gate')
    const utils = { verify: () => false, base64urlDecode: (v: string) => v }

    const outer = {
      id: '00000000-0000-4000-8000-0000000000a1',
      nodeType: 'site',
      parentId: 'root',
      ownerId: 'alice',
      storage_path: 'bffless/apps/uploads/content/proto',
    }
    const inner = {
      id: '00000000-0000-4000-8000-0000000000b2',
      nodeType: 'site',
      parentId: 'root',
      ownerId: 'bob',
      storage_path: 'bffless/apps/uploads/content/proto/docs',
    }

    const run = (userId: string | null, fullKey: string, allSites = [outer, inner]) =>
      gate({
        user: userId ? { id: userId } : null,
        request: { headers: {} },
        utils,
        steps: { allFolders: [], allSites, parsePath: { fullKey }, nodeByKey: [] },
      })

    const asset = 'bffless/apps/uploads/content/proto/docs/assets/app.js'

    // The deepest Site (bob's) owns the asset: bob is let in, alice — who owns only the
    // shallower enclosing Site — is not.
    expect(run('bob', asset)).toMatchObject({ allow: true, level: 'owner', hasNode: false, resolved: true })
    expect(run('alice', asset)).toMatchObject({ allow: false, deny403: true, deny404: false })

    // Longest prefix, not first match: the answer must not depend on query order.
    expect(run('bob', asset, [inner, outer])).toMatchObject({ allow: true, level: 'owner' })
    expect(run('alice', asset, [inner, outer])).toMatchObject({ allow: false, deny403: true })

    // The Site's own entry key (an exact storage_path match, not a child) resolves too.
    expect(run('bob', 'bffless/apps/uploads/content/proto/docs')).toMatchObject({ allow: true, resolved: true })
    // …and the outer Site still owns everything outside the nested one.
    expect(run('alice', 'bffless/apps/uploads/content/proto/index.html')).toMatchObject({ allow: true })

    // A sibling key that merely shares a name-prefix ("proto2") belongs to NO site -> 404,
    // never the "proto" site's access.
    expect(run('alice', 'bffless/apps/uploads/content/proto2/index.html')).toMatchObject({
      allow: false,
      resolved: false,
      deny404: true,
    })
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
