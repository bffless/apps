// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard for the DELETE /api/node proxy rule. The embedded-JS gate
 * runs only in CE's pipeline runner (validated live); this asserts the rule is
 * present and wired the way the #33 spec requires — write-gated, with the
 * object-purge / record-delete / non-empty-folder steps gated on the right
 * precomputed flags.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'

const SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'

const proxy = await loadProxyRules()

const rule = proxy.rules.find((r) => r.pathPattern === '/api/node' && r.method === 'DELETE')
const step = (id: string) => rule!.pipelineConfig.steps.find((s: any) => s.id === id)

// ── Running the real gate ────────────────────────────────────────────────────────────────
// The gate is a function_handler: the ACL decision AND every downstream step's condition
// (doPurge / doPurgeSite / doDelete / guardBlocked / deny401 / deny403) come out of it as
// plain booleans, because a BFFless condition can only reference a simple path. So the flags
// it returns ARE the pipeline's control flow — assert them, not its source text.

const gate = compileHandler(step('gate').config.code)

const FOLDER = '00000000-0000-4000-8000-0000000000b1'
const FILE = '00000000-0000-4000-8000-0000000000f1'
const SITE = '00000000-0000-4000-8000-00000000005e'

/** A stand-in for the sandbox's HMAC utils: `sig-<body>` is a "valid" signature. */
const utils = {
  verify: (body: string, sig: string) => sig === `sig-${body}`,
  base64urlDecode: (b: string) => Buffer.from(b, 'base64url').toString('utf8'),
}

/** A signed Handoff cookie token (`base64url(json).<sig>`), as `hf_s` carries a share link. */
function token(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.sig-${body}`
}

const folderRow = (grants: unknown[] = [], over: Record<string, any> = {}) => ({
  id: FOLDER,
  nodeType: 'folder',
  parentId: 'root',
  ownerId: 'alice',
  grantsJson: JSON.stringify(grants),
  mode: 'inheriting',
  displayName: 'Docs',
  ...over,
})

const fileRow = {
  id: FILE,
  nodeType: 'file',
  parentId: FOLDER,
  ownerId: 'alice',
  storage_path: 'bffless/apps/uploads/content/docs/a.txt',
}

/** Run the gate as `user` (null = logged out), deleting `node`, with `folders` as the chain. */
function runGate(opts: {
  user?: { id: string; role?: string } | null
  node?: Record<string, any> | null
  folders?: Record<string, any>[]
  children?: unknown[]
  cookie?: string
}): Record<string, any> {
  return gate({
    user: opts.user ?? null,
    request: { headers: opts.cookie ? { cookie: opts.cookie } : {} },
    utils,
    steps: {
      allFolders: opts.folders ?? [folderRow()],
      query: opts.node ?? fileRow,
      children: opts.children ?? [],
    },
  })
}

describe('handoff DELETE /api/node proxy rule', () => {
  it('exists as an enabled pipeline rule', () => {
    expect(rule).toBeTruthy()
    expect(rule!.proxyType).toBe('pipeline')
    expect(rule!.isEnabled).toBe(true)
  })

  it('has the expected pipeline steps in order', () => {
    const ids = rule!.pipelineConfig.steps.map((s: any) => s.id)
    expect(ids).toEqual([
      'pre', 'query', 'allFolders', 'children', 'gate',
      'guardNonEmpty', 'purgeObject', 'purgeSiteAssets',
      'del', 'response', 'deny401', 'deny403',
    ])
  })

  it('loads the node + folder chain + a child existence probe on the known schema', () => {
    expect(step('query').config.recordId).toBe('request.query.id')
    expect(step('query').config.schemaId).toBe(SCHEMA)
    expect(step('query').config.condition).toBe('steps.pre.idOk')
    // Widened in Task 5 so the singleton root record R is also fetched into the
    // chain (folder OR root), letting a root-scoped grantee be matched.
    expect(step('allFolders').config.filters.nodeType).toEqual({
      op: 'in',
      value: ['folder', 'root'],
    })
    // Cheap existence probe so a non-empty folder can be refused.
    expect(step('children').config.filters.parentId.value).toBe('request.query.id')
    expect(step('children').config.pageSize).toBe(1)
  })

  it('is a function_handler reusing the shared ACL chain walk', () => {
    expect(step('gate').handlerType).toBe('function_handler')
    expect(step('gate').config.code as string).toContain('function folderChain')
  })

  it('gates on WRITE access (rank >= 2): view-only is refused, edit/owner/admin may delete', () => {
    // DELETE needs edit or better. A `view` grant reads — it must never delete.
    const viewer = runGate({ user: { id: 'bob' }, folders: [folderRow([{ principalId: 'bob', level: 'view' }])] })
    expect(viewer).toMatchObject({ allow: false, level: 'view', deny401: false, deny403: true, doDelete: false })

    const editor = runGate({ user: { id: 'bob' }, folders: [folderRow([{ principalId: 'bob', level: 'edit' }])] })
    expect(editor).toMatchObject({ allow: true, level: 'edit', deny401: false, deny403: false, doDelete: true })

    const owner = runGate({ user: { id: 'alice' } })
    expect(owner).toMatchObject({ allow: true, level: 'owner', doDelete: true })

    const admin = runGate({ user: { id: 'zed', role: 'admin' } })
    expect(admin).toMatchObject({ allow: true, level: 'owner', doDelete: true })

    // A share-link visitor holds `view` at most (ADR-0002) — never write, however deep the link.
    const shareLink = runGate({ cookie: `hf_s=${token({ s: FOLDER, exp: Date.now() + 60_000 })}` })
    expect(shareLink).toMatchObject({ allow: false, level: 'view', deny401: false, deny403: true, doDelete: false })

    // …and an `anyone` (Public) grant is likewise capped at view: public never means deletable.
    const anon = runGate({ folders: [folderRow([{ principalId: 'anyone', level: 'view' }])] })
    expect(anon).toMatchObject({ allow: false, deny401: true, deny403: false, doDelete: false })
  })

  it('emits the downstream flags the later steps are conditioned on', () => {
    // Each step condition is a bare path into this handler's result, so the flags must line up
    // with what the ACL decided: purge the object for a file, delete the record, no site sweep.
    const out = runGate({ user: { id: 'alice' } })
    expect(out).toMatchObject({
      isFile: true,
      isFolder: false,
      isSite: false,
      storageKey: 'content/docs/a.txt',
      doPurge: true,
      doPurgeSite: false,
      sitePrefix: '',
      guardBlocked: false,
      doDelete: true,
    })

    // A non-empty folder is refused (409) — and nothing is purged or deleted.
    const nonEmpty = runGate({ user: { id: 'alice' }, node: folderRow(), children: [{ id: FILE }] })
    expect(nonEmpty).toMatchObject({ allow: true, guardBlocked: true, doDelete: false, doPurge: false })

    // A denied caller purges nothing, even on a file that has a storage key.
    const denied = runGate({ user: { id: 'bob' }, folders: [folderRow([{ principalId: 'bob', level: 'view' }])] })
    expect(denied).toMatchObject({ doPurge: false, doPurgeSite: false, doDelete: false })
  })

  it('refuses a non-empty folder with 409 before deleting', () => {
    expect(step('guardNonEmpty').handlerType).toBe('response_handler')
    expect(step('guardNonEmpty').config.status).toBe(409)
    expect(step('guardNonEmpty').config.condition).toBe('steps.gate.guardBlocked')
  })

  it('purges the stored object for files via file_delete key-mode', () => {
    expect(step('purgeObject').handlerType).toBe('file_delete')
    expect(step('purgeObject').config.key).toBe('{{steps.gate.storageKey}}')
    expect(step('purgeObject').config.condition).toBe('steps.gate.doPurge')
  })

  it("purges a Site's assets by content-path prefix (file_delete prefix-mode) with a trailing slash", () => {
    // Sites use path-passthrough storage (no manifest to enumerate). On delete
    // the whole content prefix is swept, so a future Site reusing the same path
    // can't serve stale leftover assets. The trailing slash keeps a sibling site
    // that merely shares a name-prefix (e.g. "proto" vs "proto2") untouched.
    const purge = step('purgeSiteAssets')
    expect(purge.handlerType).toBe('file_delete')
    expect(purge.config.prefix).toBe('{{steps.gate.sitePrefix}}')
    expect(purge.config.condition).toBe('steps.gate.doPurgeSite')

    const site = {
      id: SITE,
      nodeType: 'site',
      parentId: FOLDER,
      ownerId: 'alice',
      storage_path: 'bffless/apps/uploads/content/docs/proto',
    }
    const out = runGate({ user: { id: 'alice' }, node: site })
    expect(out).toMatchObject({
      isSite: true,
      storageKey: 'content/docs/proto',
      doPurgeSite: true,
      doPurge: false, // the key-mode purge is for files only
      doDelete: true,
    })

    // THE trailing slash: the prefix is the site's content path plus '/', so the sweep can only
    // ever match objects INSIDE the site — a sibling whose name merely starts the same is safe.
    expect(out.sitePrefix).toBe('content/docs/proto/')
    expect(out.sitePrefix.endsWith('/')).toBe(true)
    expect('content/docs/proto/index.html'.startsWith(out.sitePrefix)).toBe(true)
    expect('content/docs/proto2/index.html'.startsWith(out.sitePrefix)).toBe(false)

    // A view-only caller sweeps nothing; a file never takes the prefix path at all.
    const viewOnly = runGate({
      user: { id: 'bob' },
      node: site,
      folders: [folderRow([{ principalId: 'bob', level: 'view' }])],
    })
    expect(viewOnly).toMatchObject({ doPurgeSite: false, doDelete: false })
    expect(runGate({ user: { id: 'alice' } })).toMatchObject({ sitePrefix: '', doPurgeSite: false })

    // The retired manifest-based enumeration stays gone.
    expect(step('siteKeys')).toBeUndefined()
    expect(step('gate').config.code as string).not.toContain('manifest')
  })

  it('hard-deletes the record and 200s only when actually deleted', () => {
    expect(step('del').handlerType).toBe('data_delete')
    expect(step('del').config.recordId).toBe('request.query.id')
    expect(step('del').config.schemaId).toBe(SCHEMA)
    expect(step('del').config.condition).toBe('steps.gate.doDelete')
    expect(step('response').config.status).toBe(200)
    expect(step('response').config.condition).toBe('steps.gate.doDelete')
  })

  it('returns 401 without a credential and 403 when insufficient', () => {
    expect(step('deny401').config.status).toBe(401)
    expect(step('deny401').config.condition).toBe('steps.gate.deny401')
    expect(step('deny403').config.status).toBe(403)
    expect(step('deny403').config.condition).toBe('steps.gate.deny403')
  })
})
