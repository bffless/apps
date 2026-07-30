// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'

const proxy = await loadProxyRules()
const rule = proxy.rules.find((r) => r.pathPattern === '/api/comments' && r.method === 'GET')
const step = (id: string) => rule!.pipelineConfig.steps.find((s: any) => s.id === id)

const FOLDER = '00000000-0000-4000-8000-0000000000b1'
const FILE = '00000000-0000-4000-8000-0000000000f1'

const utils = {
  verify: (body: string, sig: string) => sig === `sig-${body}`,
  base64urlDecode: (b: string) => Buffer.from(b, 'base64url').toString('utf8'),
}
function token(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.sig-${body}`
}

const folderRow = (grants: unknown[] = []) => ({
  id: FOLDER, nodeType: 'folder', parentId: 'root', ownerId: 'alice',
  grantsJson: JSON.stringify(grants), mode: 'inheriting',
})
const fileRow = { id: FILE, nodeType: 'file', parentId: FOLDER, ownerId: 'alice' }

it('schema handoff_comments is exported with the comment fields', () => {
  const schema = proxy.schemas.find((s) => s.name === 'handoff_comments')
  expect(schema).toBeDefined()
  const names = schema!.fields.map((f: any) => f.name)
  for (const f of ['nodeId', 'parentId', 'authorId', 'body', 'anchorJson', 'resolved', 'reactionsJson', 'deleted', 'createdMs']) {
    expect(names).toContain(f)
  }
})

it('rule exists and the comments query is gated on steps.gate.allow', () => {
  expect(rule).toBeDefined()
  expect(step('comments').config.condition).toBe('steps.gate.allow')
  // `handoff_comments` has no `id:` in its schema manifest (the table doesn't exist yet), so
  // the compiler resolves `$schema:handoff_comments` to a deterministic uuidv5(name) — the
  // same id `proxy.schemas` reports for it — rather than leaving the literal ref string.
  const schema = proxy.schemas.find((s) => s.name === 'handoff_comments')
  expect(step('comments').config.schemaId).toBe(schema!.id)
})

describe('gate', () => {
  const gate = compileHandler(step('gate').config.code)
  const run = (opts: { user?: any; cookie?: string; node?: any; folders?: any[]; pre?: any }) =>
    gate({
      user: opts.user ?? null,
      request: { headers: opts.cookie ? { cookie: opts.cookie } : {} },
      utils,
      steps: { pre: opts.pre ?? { idOk: true }, allFolders: opts.folders ?? [folderRow()], query: opts.node ?? fileRow },
    })

  it('owner reads', () => expect(run({ user: { id: 'alice' } }).allow).toBe(true))
  it('admin reads', () => expect(run({ user: { id: 'zed', role: 'admin' } }).allow).toBe(true))
  it('granted viewer reads', () =>
    expect(run({ user: { id: 'bob' }, folders: [folderRow([{ principalId: 'bob', level: 'view' }])] }).allow).toBe(true))
  it('share-cookie visitor reads (folder in chain)', () =>
    expect(run({ cookie: `hf_s=${token({ s: FOLDER, exp: Date.now() + 60000 })}` }).allow).toBe(true))
  it('anon → 401', () => {
    const r = run({})
    expect(r.allow).toBe(false); expect(r.deny401).toBe(true); expect(r.deny403).toBe(false)
  })
  it('ungranted user → 403', () => {
    const r = run({ user: { id: 'mallory' } })
    expect(r.allow).toBe(false); expect(r.deny403).toBe(true)
  })
  it('bad nodeId → badRequest', () =>
    expect(run({ user: { id: 'alice' }, pre: { idOk: false }, node: null }).badRequest).toBe(true))
  it('member of a granted group reads', () =>
    expect(
      run({
        user: { id: 'carol', groups: ['group-1'] },
        folders: [folderRow([{ principalId: 'group-1', principalType: 'group', level: 'view' }])],
      }).allow,
    ).toBe(true))
  it('non-member of the granted group → 403', () => {
    const r = run({
      user: { id: 'carol', groups: ['group-2'] },
      folders: [folderRow([{ principalId: 'group-1', principalType: 'group', level: 'view' }])],
    })
    expect(r.allow).toBe(false)
    expect(r.deny403).toBe(true)
  })
})

describe('shape', () => {
  const shape = compileHandler(step('shape').config.code)
  it('passes live comments through and strips soft-deleted roots to husks (keeping anchorJson)', () => {
    const out = shape({
      steps: {
        comments: [
          { id: 'c1', nodeId: FILE, parentId: '', authorId: 'u1', authorName: 'a@b', body: 'hi', createdMs: 1 },
          {
            id: 'c2', nodeId: FILE, parentId: '', authorId: 'u2', authorName: 'x@y', body: 'secret',
            deleted: true, createdMs: 2, anchorJson: '{"type":"pin","x":0.5,"y":0.5}',
          },
        ],
      },
    } as any)
    const list = JSON.parse(out.comments)
    expect(list[0].body).toBe('hi')
    expect(list[1]).toEqual({
      id: 'c2', nodeId: FILE, parentId: '', deleted: true, createdMs: 2,
      anchorJson: '{"type":"pin","x":0.5,"y":0.5}',
    })
  })
})
