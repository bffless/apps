// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'

const proxy = await loadProxyRules()
const rule = proxy.rules.find((r) => r.pathPattern === '/api/comments' && r.method === 'DELETE')
const step = (id: string) => rule!.pipelineConfig.steps.find((s: any) => s.id === id)

const COMMENT = '00000000-0000-4000-8000-0000000000c9'
const ROOT = '00000000-0000-4000-8000-0000000000c8'

const commentRow = {
  id: COMMENT, nodeId: 'file-1', parentId: '', authorId: 'bob', body: 'old',
  authorName: 'Bob', deleted: false,
}
const replyRow = {
  id: COMMENT, nodeId: 'file-1', parentId: ROOT, authorId: 'bob', body: 'reply text',
  authorName: 'Bob', deleted: false,
}

it('rule exists', () => {
  expect(rule).toBeDefined()
})

it('data steps are pinned to the compiler-resolved schema ids', () => {
  const commentsSchema = proxy.schemas.find((s) => s.name === 'handoff_comments')
  expect(commentsSchema).toBeDefined()
  expect(step('comment').config.schemaId).toBe(commentsSchema!.id)
  expect(step('replies').config.schemaId).toBe(commentsSchema!.id)
  expect(step('softDelete').config.schemaId).toBe(commentsSchema!.id)
  expect(step('hardDelete').config.schemaId).toBe(commentsSchema!.id)
})

it('wires softDelete on doSoft with deleted/body/authorName cleared, and hardDelete as data_delete on doHard', () => {
  expect(step('softDelete').config.condition).toBe('steps.gate.doSoft')
  expect(step('softDelete').config.fields).toEqual({ deleted: true, body: '', authorName: '' })
  expect(step('softDelete').config.recordId).toBe('request.query.id')

  expect(step('hardDelete').handlerType).toBe('data_delete')
  expect(step('hardDelete').config.condition).toBe('steps.gate.doHard')
  expect(step('hardDelete').config.recordId).toBe('request.query.id')
})

it('ok response interpolates id and softFlag, gated on okFlag', () => {
  expect(step('ok').config.body).toBe('{"id":"{{steps.pre.id}}","soft":{{steps.gate.softFlag}}}')
  expect(step('ok').config.status).toBe(200)
  expect(step('ok').config.condition).toBe('steps.gate.okFlag')
})

describe('gate', () => {
  const gate = compileHandler(step('gate').config.code)

  const okPre = { id: COMMENT, idOk: true }
  const badPre = { id: 'not-a-uuid', idOk: false }

  const run = (opts: { user?: any; pre?: any; comment?: any; replies?: any[] }) =>
    gate({
      user: opts.user ?? null,
      request: { headers: {} },
      utils: {},
      steps: {
        pre: opts.pre ?? okPre,
        comment: 'comment' in opts ? opts.comment : commentRow,
        replies: opts.replies ?? [],
      },
    })

  it('author deletes own reply → doHard, not doSoft', () => {
    const r = run({ user: { id: 'bob' }, comment: replyRow, replies: [] })
    expect(r.doHard).toBe(true)
    expect(r.doSoft).toBe(false)
    expect(r.okFlag).toBe(true)
    expect(r.softFlag).toBe(false)
  })

  it('author deletes root WITH replies → doSoft, not doHard', () => {
    const r = run({ user: { id: 'bob' }, comment: commentRow, replies: [{ id: 'x' }] })
    expect(r.doSoft).toBe(true)
    expect(r.doHard).toBe(false)
    expect(r.okFlag).toBe(true)
    expect(r.softFlag).toBe(true)
  })

  it('author deletes root WITHOUT replies → doHard, not doSoft', () => {
    const r = run({ user: { id: 'bob' }, comment: commentRow, replies: [] })
    expect(r.doHard).toBe(true)
    expect(r.doSoft).toBe(false)
    expect(r.softFlag).toBe(false)
  })

  it('non-author → 403', () => {
    const r = run({ user: { id: 'alice' }, comment: commentRow })
    expect(r.deny403).toBe(true)
    expect(r.okFlag).toBe(false)
  })

  it('admin non-author → 403 (v1: admins do not moderate-delete)', () => {
    const r = run({ user: { id: 'alice', role: 'admin' }, comment: commentRow })
    expect(r.deny403).toBe(true)
    expect(r.okFlag).toBe(false)
  })

  it('anonymous → 401', () => {
    const r = run({ user: null, comment: commentRow })
    expect(r.deny401).toBe(true)
    expect(r.okFlag).toBe(false)
  })

  it('share-cookie-only (no session user) → 401', () => {
    // The gate only trusts a session user.id — a viewer with no `user` at all (share-cookie
    // or fully anonymous) has no uid, so both collapse to the same 401 branch.
    const r = run({ user: undefined, comment: commentRow })
    expect(r.deny401).toBe(true)
  })

  it('missing comment → badRequest', () => {
    const r = run({ user: { id: 'bob' }, comment: null })
    expect(r.badRequest).toBe(true)
    expect(r.deny401).toBe(false)
    expect(r.deny403).toBe(false)
    expect(r.okFlag).toBe(false)
  })

  it('bad id (pre.idOk false) → badRequest', () => {
    const r = run({ user: { id: 'bob' }, pre: badPre, comment: commentRow })
    expect(r.badRequest).toBe(true)
  })

  it('already-deleted comment → badRequest', () => {
    const r = run({ user: { id: 'bob' }, comment: { ...commentRow, deleted: true } })
    expect(r.badRequest).toBe(true)
    expect(r.okFlag).toBe(false)
  })
})
