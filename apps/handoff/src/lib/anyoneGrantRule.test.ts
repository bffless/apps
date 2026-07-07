// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard + port-equivalence for the Anyone principal (ADR-0005).
 * Extracts the REAL embedded evalAccess from the proxy rules and runs it
 * against the same matrix as the canonical src/lib/acl.ts implementation.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { evaluateAccess, ANYONE_PRINCIPAL } from './acl'
import type { FolderLink, Viewer, AccessLevel } from './acl'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

function evalAccessCopies(): string[] {
  const out: string[] = []
  for (const r of proxy.rules) {
    for (const s of r.pipelineConfig?.steps ?? []) {
      const code: string = s.config?.code ?? ''
      const i = code.indexOf('function evalAccess')
      if (i < 0) continue
      let depth = 0
      let j = code.indexOf('{', i)
      for (; j < code.length; j++) {
        if (code[j] === '{') depth++
        else if (code[j] === '}') {
          depth--
          if (depth === 0) break
        }
      }
      out.push(code.slice(i, j + 1))
    }
  }
  return out
}

describe('embedded evalAccess copies (structural)', () => {
  const copies = evalAccessCopies()

  it('there are exactly 9 copies and they are identical', () => {
    // 7 original + the two /feed/* + /feed.xml select handlers (#188), each a
    // verbatim copy of the canonical evalAccess.
    expect(copies.length).toBe(9)
    expect(new Set(copies).size).toBe(1)
  })

  it('every copy matches the anyone principal and never short-circuits guests', () => {
    for (const c of copies) {
      expect(c).toContain("principalId==='anyone'")
      expect(c).not.toContain("if(!vw.userId)return 'none';")
    }
  })
})

describe('embedded evalAccess ≡ evaluateAccess (port equivalence)', () => {
  const body = evalAccessCopies()[0]
  const embedded = new Function(
    `var rank=function(l){return l==='owner'?3:l==='edit'?2:l==='view'?1:0;}; return (${body})`,
  )() as (ch: FolderLink[], vw: Viewer) => AccessLevel

  const anyone = { principalId: ANYONE_PRINCIPAL, level: 'view' as const }
  const F = (over: Partial<FolderLink> = {}): FolderLink =>
    ({ id: 'f1', ownerId: 'owner-1', grants: [], mode: 'inheriting', ...over })

  const MATRIX: Array<{ name: string; chain: FolderLink[]; viewer: Viewer; want: AccessLevel }> = [
    { name: 'admin', chain: [F()], viewer: { userId: 'x', isAdmin: true }, want: 'owner' },
    { name: 'owner in chain', chain: [F()], viewer: { userId: 'owner-1' }, want: 'owner' },
    { name: 'anon + anyone on target', chain: [F({ grants: [anyone] })], viewer: {}, want: 'view' },
    {
      name: 'anon inherits ancestor anyone',
      chain: [F({ id: 'p', grants: [anyone] }), F({ id: 'c', ownerId: 'o2' })],
      viewer: {},
      want: 'view',
    },
    {
      name: 'restricted cuts anyone',
      chain: [F({ id: 'p', grants: [anyone] }), F({ id: 'c', ownerId: 'o2', mode: 'restricted' })],
      viewer: {},
      want: 'none',
    },
    {
      name: 'anyone capped at view (bad edit data)',
      chain: [F({ grants: [{ principalId: ANYONE_PRINCIPAL, level: 'edit' as const }] })],
      viewer: {},
      want: 'view',
    },
    {
      name: 'signed-in ungranted gets view from anyone',
      chain: [F({ grants: [anyone] })],
      viewer: { userId: 'u9' },
      want: 'view',
    },
    {
      name: 'personal edit beats anyone',
      chain: [F({ grants: [anyone, { principalId: 'u9', level: 'edit' as const }] })],
      viewer: { userId: 'u9' },
      want: 'edit',
    },
    {
      name: 'guest link out of scope + anyone',
      chain: [F({ id: 'other', grants: [anyone] })],
      viewer: { shareLinkFolderId: 'nope' },
      want: 'view',
    },
    {
      name: 'guest link in scope, no anyone',
      chain: [F({ id: 'scope' })],
      viewer: { shareLinkFolderId: 'scope' },
      want: 'view',
    },
    { name: 'anon nothing', chain: [F()], viewer: {}, want: 'none' },
    {
      name: 'personal grant below restricted still counts',
      chain: [F({ id: 'p', grants: [anyone] }), F({ id: 'c', ownerId: 'o2', mode: 'restricted', grants: [{ principalId: 'u9', level: 'view' as const }] })],
      viewer: { userId: 'u9' },
      want: 'view',
    },
  ]

  for (const c of MATRIX) {
    it(c.name, () => {
      expect(embedded(c.chain, c.viewer)).toBe(c.want)
      expect(evaluateAccess({ folderChain: c.chain, viewer: c.viewer })).toBe(c.want)
    })
  }
})

describe('grants merge caps the Anyone principal at view', () => {
  const grantsPost = proxy.rules.find(
    (r) => r.pathPattern === '/api/grants' && r.method === 'POST',
  )!
  const mergeStep = grantsPost.pipelineConfig.steps.find((s: any) => s.id === 'merge')
  const mergeCode: string = mergeStep.config.code

  it('contains the cap', () => {
    expect(mergeCode).toContain("pid === 'anyone'")
  })

  it('behaviorally: an edit-level anyone request is stored as view', () => {
    const handler = new Function(`return (${mergeCode})`)() as (ctx: any) => any
    const out = handler({
      user: { id: 'owner-1', role: 'admin' },
      request: { body: { folderId: 'f1', principalId: 'anyone', level: 'edit' } },
      steps: {
        folder: { id: 'f1', ownerId: 'owner-1', grantsJson: '[]' },
        resolveRootShape: { effectiveFolderId: 'f1', rootOwnerId: null },
      },
    })
    expect(out.allowed).toBe(true)
    expect(out.grants).toEqual([{ principalId: 'anyone', principalEmail: null, level: 'view' }])
  })

  it('behaviorally: replacing an existing anyone grant with stale principalEmail still nulls it', () => {
    const handler = new Function(`return (${mergeCode})`)() as (ctx: any) => any
    const out = handler({
      user: { id: 'owner-1', role: 'admin' },
      request: { body: { folderId: 'f1', principalId: 'anyone', level: 'edit' } },
      steps: {
        folder: {
          id: 'f1',
          ownerId: 'owner-1',
          grantsJson: JSON.stringify([
            { principalId: 'anyone', principalEmail: 'legacy@example.com', level: 'edit' },
          ]),
        },
        resolveRootShape: { effectiveFolderId: 'f1', rootOwnerId: null },
      },
    })
    expect(out.grants).toEqual([{ principalId: 'anyone', principalEmail: null, level: 'view' }])
  })
})
