// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'

const proxy = await loadProxyRules()
const rule = proxy.rules.find((r) => r.pathPattern === '/api/comments' && r.method === 'PATCH')
const step = (id: string) => rule!.pipelineConfig.steps.find((s: any) => s.id === id)

const FOLDER = '00000000-0000-4000-8000-0000000000d1'
const FILE = '00000000-0000-4000-8000-0000000000f2'
const COMMENT = '00000000-0000-4000-8000-0000000000c9'
const ROOT = '00000000-0000-4000-8000-0000000000c8'

const utils = {
  verify: (body: string, sig: string) => sig === `sig-${body}`,
  base64urlDecode: (b: string) => Buffer.from(b, 'base64url').toString('utf8'),
}
function token(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.sig-${body}`
}

const folderRow = (grants: unknown[] = [{ principalId: 'anyone', level: 'view' }]) => ({
  id: FOLDER, nodeType: 'folder', parentId: 'root', ownerId: 'zed',
  grantsJson: JSON.stringify(grants), mode: 'inheriting',
})
const fileRow = { id: FILE, nodeType: 'file', parentId: FOLDER, ownerId: 'zed' }

const commentRow = {
  id: COMMENT, nodeId: FILE, parentId: '', authorId: 'bob', body: 'old',
  reactionsJson: '{"👍":["alice"]}', resolved: false,
}

it('rule exists', () => {
  expect(rule).toBeDefined()
})

it('data steps are pinned to the compiler-resolved schema ids', () => {
  const nodesSchema = proxy.schemas.find((s) => s.name === 'handoff_nodes')
  const commentsSchema = proxy.schemas.find((s) => s.name === 'handoff_comments')
  expect(nodesSchema).toBeDefined()
  expect(commentsSchema).toBeDefined()
  expect(step('query').config.schemaId).toBe(nodesSchema!.id)
  expect(step('allFolders').config.schemaId).toBe(nodesSchema!.id)
  expect(step('comment').config.schemaId).toBe(commentsSchema!.id)
  expect(step('final').config.schemaId).toBe(commentsSchema!.id)
  expect(step('editUpdate').config.schemaId).toBe(commentsSchema!.id)
  expect(step('resolveUpdate').config.schemaId).toBe(commentsSchema!.id)
  expect(step('reactUpdate').config.schemaId).toBe(commentsSchema!.id)
})

it('wires each data_update on its do* flag, recordId, and schema; final on okFlag', () => {
  expect(step('editUpdate').config.condition).toBe('steps.gate.doEdit')
  expect(step('resolveUpdate').config.condition).toBe('steps.gate.doResolve')
  expect(step('reactUpdate').config.condition).toBe('steps.gate.doReact')
  expect(step('final').config.condition).toBe('steps.gate.okFlag')
  for (const id of ['editUpdate', 'resolveUpdate', 'reactUpdate']) {
    expect(step(id).config.recordId).toBe('request.body.id')
    expect(step(id).config.schemaId).toBe(step('comment').config.schemaId)
  }
})

describe('gate', () => {
  const gate = compileHandler(step('gate').config.code)

  const editPre = { idOk: true, op: 'edit', opOk: true, newBody: 'new text', bodyOk: true, emoji: '', emojiOk: false }
  const resolvePre = { idOk: true, op: 'resolve', opOk: true, newBody: '', bodyOk: false, emoji: '', emojiOk: false }
  const reopenPre = { idOk: true, op: 'reopen', opOk: true, newBody: '', bodyOk: false, emoji: '', emojiOk: false }
  const reactPre = { idOk: true, op: 'react', opOk: true, newBody: '', bodyOk: false, emoji: '👍', emojiOk: true }

  const run = (opts: { user?: any; cookie?: string; pre?: any; comment?: any; node?: any; folders?: any[] }) =>
    gate({
      user: opts.user ?? null,
      request: { headers: opts.cookie ? { cookie: opts.cookie } : {} },
      utils,
      steps: {
        pre: opts.pre ?? editPre,
        comment: opts.comment ?? commentRow,
        allFolders: opts.folders ?? [folderRow()],
        query: opts.node ?? fileRow,
      },
    })

  it('author edits own comment', () => {
    const r = run({ user: { id: 'bob' }, pre: editPre })
    expect(r.doEdit).toBe(true)
    expect(r.newBody).toBe('new text')
    expect(typeof r.nowMs).toBe('number')
  })

  it('non-author (even admin) cannot edit body → 403', () => {
    expect(run({ user: { id: 'alice' }, pre: editPre }).deny403).toBe(true)
    expect(run({ user: { id: 'z', role: 'admin' }, pre: editPre }).deny403).toBe(true)
  })

  it('any viewer with session resolves a root; resolvedBy is the caller', () => {
    const r = run({ user: { id: 'alice' }, pre: resolvePre })
    expect(r.doResolve).toBe(true)
    expect(r.newResolved).toBe(true)
    expect(r.resolvedBy).toBe('alice')
  })

  it('reopen sets newResolved false', () =>
    expect(run({ user: { id: 'alice' }, pre: reopenPre }).newResolved).toBe(false))

  it('resolve on a reply → badRequest', () =>
    expect(run({ user: { id: 'alice' }, pre: resolvePre, comment: { ...commentRow, parentId: ROOT } }).badRequest).toBe(true))

  it('react toggles the caller in/out and drops empty arrays', () => {
    const on = run({ user: { id: 'bob' }, pre: reactPre }) // 👍 not yet by bob
    expect(JSON.parse(on.newReactionsJson)).toEqual({ '👍': ['alice', 'bob'] })
    const off = run({ user: { id: 'alice' }, pre: reactPre }) // alice already reacted
    expect(JSON.parse(off.newReactionsJson)).toEqual({})
  })

  it('share-cookie only → 401 for every op', () => {
    const cookie = `hf_s=${token({ s: FOLDER, exp: Date.now() + 60000 })}`
    for (const pre of [editPre, resolvePre, reopenPre, reactPre]) {
      const r = run({ cookie: cookie, pre: pre })
      expect(r.okFlag).toBe(false)
      expect(r.deny401).toBe(true)
    }
  })

  it('soft-deleted comment → badRequest for every op', () => {
    const deletedComment = { ...commentRow, deleted: true }
    for (const pre of [editPre, resolvePre, reopenPre, reactPre]) {
      const r = run({ user: { id: 'bob' }, pre: pre, comment: deletedComment })
      expect(r.badRequest).toBe(true)
    }
  })

  it('exactly one do* flag true per op', () => {
    const cases: Array<[any, string]> = [
      [editPre, 'bob'],
      [resolvePre, 'alice'],
      [reopenPre, 'alice'],
      [reactPre, 'bob'],
    ]
    for (const [pre, uid] of cases) {
      const r = run({ user: { id: uid }, pre: pre })
      const flags = [r.doEdit, r.doResolve, r.doReact]
      expect(flags.filter(Boolean).length).toBe(1)
    }
  })
})

describe('pre', () => {
  const pre = compileHandler(step('pre').config.code)
  const run = (body: any) => pre({ request: { body } } as any)

  it('valid UUID id → idOk:true', () => {
    expect(run({ id: COMMENT, op: 'edit', body: 'hi' }).idOk).toBe(true)
  })
  it('non-UUID id → idOk:false', () => {
    expect(run({ id: 'not-a-uuid', op: 'edit', body: 'hi' }).idOk).toBe(false)
  })
  it('known op → opOk:true; unknown op → opOk:false', () => {
    expect(run({ id: COMMENT, op: 'edit' }).opOk).toBe(true)
    expect(run({ id: COMMENT, op: 'resolve' }).opOk).toBe(true)
    expect(run({ id: COMMENT, op: 'reopen' }).opOk).toBe(true)
    expect(run({ id: COMMENT, op: 'react' }).opOk).toBe(true)
    expect(run({ id: COMMENT, op: 'delete' }).opOk).toBe(false)
    expect(run({ id: COMMENT }).opOk).toBe(false)
  })
  it('empty body → bodyOk:false', () => {
    expect(run({ id: COMMENT, op: 'edit', body: '' }).bodyOk).toBe(false)
    expect(run({ id: COMMENT, op: 'edit', body: '   ' }).bodyOk).toBe(false)
  })
  it('5001-char body → bodyOk:false; 5000-char body → bodyOk:true', () => {
    expect(run({ id: COMMENT, op: 'edit', body: 'x'.repeat(5001) }).bodyOk).toBe(false)
    expect(run({ id: COMMENT, op: 'edit', body: 'x'.repeat(5000) }).bodyOk).toBe(true)
  })
  it('body is trimmed into newBody', () => {
    expect(run({ id: COMMENT, op: 'edit', body: '  new text  ' }).newBody).toBe('new text')
  })
  it('empty/missing emoji → emojiOk:false; non-empty ≤16 chars → emojiOk:true', () => {
    expect(run({ id: COMMENT, op: 'react' }).emojiOk).toBe(false)
    expect(run({ id: COMMENT, op: 'react', emoji: '' }).emojiOk).toBe(false)
    expect(run({ id: COMMENT, op: 'react', emoji: '👍' }).emojiOk).toBe(true)
  })
  it('17-char emoji → emojiOk:false', () => {
    expect(run({ id: COMMENT, op: 'react', emoji: 'x'.repeat(17) }).emojiOk).toBe(false)
  })
})
