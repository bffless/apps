// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'

const proxy = await loadProxyRules()
const rule = proxy.rules.find((r) => r.pathPattern === '/api/comments' && r.method === 'POST')
const step = (id: string) => rule!.pipelineConfig.steps.find((s: any) => s.id === id)

const FOLDER = '00000000-0000-4000-8000-0000000000b1'
const FILE = '00000000-0000-4000-8000-0000000000f1'
const ROOT_COMMENT = '00000000-0000-4000-8000-0000000000c1'

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

it('rule exists', () => {
  expect(rule).toBeDefined()
})

it('data steps are pinned to the compiler-resolved schema ids', () => {
  // Same precedent as commentsListRule.test.ts:44 — `$schema:` refs resolve to the schema's
  // id in the export (uuidv5 for handoff_comments, since its manifest carries no `id:`; the
  // literal `id:` handoff_nodes already declares for the others).
  const nodesSchema = proxy.schemas.find((s) => s.name === 'handoff_nodes')
  const commentsSchema = proxy.schemas.find((s) => s.name === 'handoff_comments')
  expect(nodesSchema).toBeDefined()
  expect(commentsSchema).toBeDefined()
  expect(step('query').config.schemaId).toBe(nodesSchema!.id)
  expect(step('allFolders').config.schemaId).toBe(nodesSchema!.id)
  expect(step('parentComment').config.schemaId).toBe(commentsSchema!.id)
  expect(step('create').config.schemaId).toBe(commentsSchema!.id)
})

describe('gate', () => {
  const gate = compileHandler(step('gate').config.code)
  const goodPre = {
    ok: true, isReply: false, bodyValue: 'hi', parentIdValue: '',
    anchorValue: '{"type":"text","quote":"q","prefix":"","suffix":"","start":1,"end":2}',
  }
  const run = (opts: { user?: any; cookie?: string; pre?: any; node?: any; folders?: any[]; parentComment?: any }) =>
    gate({
      user: opts.user ?? null,
      request: { headers: opts.cookie ? { cookie: opts.cookie } : {} },
      utils,
      steps: {
        pre: opts.pre ?? goodPre,
        allFolders: opts.folders ?? [folderRow([{ principalId: 'bob', level: 'view' }])],
        query: opts.node ?? fileRow,
        parentComment: opts.parentComment ?? null,
      },
    })

  it('a granted viewer with a session may comment', () => {
    const r = run({ user: { id: 'bob', email: 'bob@x.y' } })
    expect(r.allow).toBe(true)
    expect(r.authorName).toBe('bob@x.y')
  })
  it('gate stamps nowMs as an epoch-ms number (ce#562: CE now() writes ISO strings)', () => {
    const r = run({ user: { id: 'bob', email: 'bob@x.y' } })
    expect(typeof r.nowMs).toBe('number')
  })
  it('share-cookie visitor CANNOT write → 401', () => {
    const r = run({ cookie: `hf_s=${token({ s: FOLDER, exp: Date.now() + 60000 })}` })
    expect(r.allow).toBe(false); expect(r.deny401).toBe(true)
  })
  it('anon → 401; sessioned but ungranted → 403', () => {
    expect(run({}).deny401).toBe(true)
    const r = run({ user: { id: 'mallory' }, folders: [folderRow()] })
    expect(r.deny403).toBe(true)
  })
  it('owner and admin may comment', () => {
    expect(run({ user: { id: 'alice' }, folders: [folderRow()] }).allow).toBe(true)
    expect(run({ user: { id: 'z', role: 'admin' }, folders: [folderRow()] }).allow).toBe(true)
  })
  it('reply must target an existing ROOT comment on the SAME node', () => {
    const replyPre = { ...goodPre, isReply: true, parentIdValue: ROOT_COMMENT, anchorValue: '' }
    const rootOk = { id: ROOT_COMMENT, nodeId: FILE, parentId: '' }
    expect(run({ user: { id: 'bob' }, pre: replyPre, parentComment: rootOk }).allow).toBe(true)
    expect(run({ user: { id: 'bob' }, pre: replyPre, parentComment: null }).badRequest).toBe(true)
    expect(run({ user: { id: 'bob' }, pre: replyPre, parentComment: { ...rootOk, nodeId: 'other' } }).badRequest).toBe(true)
    expect(run({ user: { id: 'bob' }, pre: replyPre, parentComment: { ...rootOk, parentId: ROOT_COMMENT } }).badRequest).toBe(true)
    expect(run({ user: { id: 'bob' }, pre: replyPre, parentComment: { ...rootOk, deleted: true } }).badRequest).toBe(true)
  })
  it('member of a granted group may comment', () => {
    const r = run({
      user: { id: 'carol', groups: ['group-1'] },
      folders: [folderRow([{ principalId: 'group-1', principalType: 'group', level: 'view' }])],
    })
    expect(r.allow).toBe(true)
  })
  it('non-member of the granted group → 403', () => {
    const r = run({
      user: { id: 'carol', groups: ['group-2'] },
      folders: [folderRow([{ principalId: 'group-1', principalType: 'group', level: 'view' }])],
    })
    expect(r.allow).toBe(false)
    expect(r.deny403).toBe(true)
  })
  it('create step stamps server-owned fields', () => {
    const create = step('create')
    expect(create.config.condition).toBe('steps.gate.allow')
    expect(create.config.fields.authorId).toBe('user.id')
    expect(create.config.fields.createdMs).toBe('steps.gate.nowMs')
    expect(create.config.fields.authorName).toBe('steps.gate.authorName')
    expect(create.config.fields.reactionsJson).toBe('"{}"')
  })
})

describe('pre', () => {
  const pre = compileHandler(step('pre').config.code)
  const run = (body: any) => pre({ request: { body } } as any)

  it('empty body → ok:false', () => {
    expect(run({ nodeId: FILE, body: '' }).ok).toBe(false)
  })
  it('5001-char body → ok:false', () => {
    expect(run({ nodeId: FILE, body: 'x'.repeat(5001) }).ok).toBe(false)
  })
  it('5000-char body → ok:true', () => {
    expect(run({ nodeId: FILE, body: 'x'.repeat(5000) }).ok).toBe(true)
  })
  it('non-object anchor → anchorValue: ""', () => {
    expect(run({ nodeId: FILE, body: 'hi', anchor: 'not-an-object' }).anchorValue).toBe('')
  })
  it('valid anchor is serialized as a JSON string', () => {
    const out = run({
      nodeId: FILE, body: 'hi',
      anchor: { type: 'text', quote: 'q', prefix: 'p', suffix: 's', start: 1, end: 2 },
    })
    expect(typeof out.anchorValue).toBe('string')
    expect(JSON.parse(out.anchorValue)).toEqual({ type: 'text', quote: 'q', prefix: 'p', suffix: 's', start: 1, end: 2 })
  })
  it('bad parentId (non-UUID) → ok:false', () => {
    expect(run({ nodeId: FILE, body: 'hi', parentId: 'not-a-uuid' }).ok).toBe(false)
  })
  it('valid reply sets isReply and parentIdValue, and drops the anchor', () => {
    const out = run({ nodeId: FILE, body: 'hi', parentId: ROOT_COMMENT, anchor: { type: 'text', quote: 'q', start: 1, end: 2 } })
    expect(out.ok).toBe(true)
    expect(out.isReply).toBe(true)
    expect(out.parentIdValue).toBe(ROOT_COMMENT)
    expect(out.anchorValue).toBe('')
  })
})
