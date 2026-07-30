// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard + port-equivalence for the Anyone principal (ADR-0005).
 *
 * Runs the REAL `evalAccess` that gates live requests against the same matrix as the canonical
 * `src/lib/acl.ts` implementation, so the two can't drift apart.
 *
 * This used to brace-match the `evalAccess` source back out of each handler's code string and eval
 * it, because the function was pasted — minified — into ten separate handlers, and the thing most
 * worth checking was that all ten copies were identical and none had missed the Anyone update.
 * There is one shared module now (`_shared/acl.ts`, imported by every gate and inlined per-bundle
 * by esbuild), so "all copies agree" is true by construction and the test imports the module
 * directly instead — no extraction, no eval, and it exercises the actual shipped function.
 *
 * Two risks the module doesn't remove, covered below:
 *  - a gate that quietly stops using it (checked structurally, against the compiled bundles);
 *  - the per-set copies of the module drifting (checked in aclSharedModule.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'
import { evaluateAccess, ANYONE_PRINCIPAL } from './acl'
import type { FolderLink, Viewer, AccessLevel } from './acl'
import { evalAccess } from '../../.bffless/proxy-rules/handoff/_shared/acl'
import type { ChainNode } from '../../.bffless/proxy-rules/handoff/_shared/acl'

const proxy = await loadProxyRules()

/**
 * The ten steps that must evaluate access through the shared module. If one stops importing it —
 * hand-rolling its own check, or losing the Anyone principal — that's the regression this catches.
 * Named explicitly rather than discovered, so DELETING a gate's ACL check fails the test too.
 *
 * This is the same set the old "exactly 10 identical copies" assertion counted.
 */
const EVAL_ACCESS_STEPS: Array<[path: string, method: string, step: string]> = [
  ['/api/uploads/content/*', 'GET', 'gate'],
  ['/api/nodes', 'GET', 'gate'],
  ['/api/nodes', 'GET', 'shape'], // filters children to what the viewer may see
  ['/api/node', 'GET', 'gate'],
  ['/api/node', 'DELETE', 'gate'],
  ['/api/node/meta', 'PATCH', 'gate'],
  ['/api/sign', 'POST', 'gate'],
  ['/api/resolve/*', 'GET', 'gate'],
  ['/feed/*', 'GET', 'select'],
  ['/feed.xml', 'GET', 'select'],
]

function stepCode(path: string, method: string, stepId: string): string {
  const rule = proxy.rules.find(
    (r) => r.pathPattern === path && (r.method === method || (r.methods ?? []).includes(method)),
  )
  expect(rule, `no rule for ${method} ${path}`).toBeTruthy()
  const step = rule!.pipelineConfig?.steps?.find((s: any) => s.id === stepId)
  expect(step, `${method} ${path} has no "${stepId}" step`).toBeTruthy()
  return step!.config?.code ?? ''
}

describe('every access gate ships the shared evalAccess (structural)', () => {
  it('covers ten steps — the full set that evaluates access', () => {
    expect(EVAL_ACCESS_STEPS).toHaveLength(10)
  })

  for (const [path, method, stepId] of EVAL_ACCESS_STEPS) {
    it(`${method} ${path} :: ${stepId}`, () => {
      // esbuild inlines the shared module into each bundle, preserving names.
      const code = stepCode(path, method, stepId)
      expect(code, 'step does not inline evalAccess').toContain('evalAccess')
      expect(code, 'step does not know about the Anyone principal').toContain(ANYONE_PRINCIPAL)
    })
  }
})

describe('/r/* is token-scoped, NOT Anyone-evaluated', () => {
  // The raw-file redirect is the media route a PRIVATE feed hands out (#189 / ADR-0008). It
  // deliberately does not run evalAccess: access is the share-link token plus folder scope, so a
  // tokenless /r/* is denied outright rather than falling through to the public 'anyone' grant.
  // Wiring evalAccess in here would make every Anyone-granted file reachable at /r/<id>/<slug>
  // with no token — so this asserts the ABSENCE, not the presence.
  it('walks the folder chain to scope the token, and never consults Anyone', () => {
    const code = stepCode('/r/*', 'GET', 'check')
    expect(code, '/r/* must still scope the token to a folder chain').toContain('folderChain')
    expect(code, '/r/* must NOT evaluate the Anyone principal').not.toContain('evalAccess')
  })
})

describe('embedded evalAccess ≡ evaluateAccess (port equivalence)', () => {
  // The real module the gates import — not a copy, not a re-implementation.
  const embedded = (chain: FolderLink[], viewer: Viewer): AccessLevel =>
    evalAccess(chain as unknown as ChainNode[], viewer) as AccessLevel

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
    {
      name: 'member of granted group gets view',
      chain: [F({ grants: [{ principalId: 'group-1', level: 'view' as const }] })],
      viewer: { groupIds: ['group-1'] },
      want: 'view',
    },
    {
      name: 'member of granted group gets edit',
      chain: [F({ grants: [{ principalId: 'group-1', level: 'edit' as const }] })],
      viewer: { groupIds: ['group-1'] },
      want: 'edit',
    },
    {
      name: 'non-member of granted group gets nothing',
      chain: [F({ grants: [{ principalId: 'group-1', level: 'edit' as const }] })],
      viewer: { groupIds: ['group-2'] },
      want: 'none',
    },
    {
      name: 'restricted drops inherited group grant',
      chain: [
        F({ id: 'p', grants: [{ principalId: 'group-1', level: 'edit' as const }] }),
        F({ id: 'c', ownerId: 'o2', mode: 'restricted' }),
      ],
      viewer: { groupIds: ['group-1'] },
      want: 'none',
    },
    {
      name: 'groupIds undefined does not match group grant',
      chain: [F({ grants: [{ principalId: 'group-1', level: 'view' as const }] })],
      viewer: {},
      want: 'none',
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

  // Structural sanity only — the cap is a security control, so the two behavioral cases below are
  // what actually pin it. (Asserting on an exact expression would just track whatever the handler
  // happens to name its local; the write-side behaviour is the contract.)
  it('references the Anyone principal', () => {
    expect(mergeCode).toContain(ANYONE_PRINCIPAL)
  })

  it('behaviorally: an edit-level anyone request is stored as view', () => {
    const handler = compileHandler(mergeCode) as (ctx: any) => any
    const out = handler({
      user: { id: 'owner-1', role: 'admin' },
      request: { body: { folderId: 'f1', principalId: 'anyone', level: 'edit' } },
      steps: {
        folder: { id: 'f1', ownerId: 'owner-1', grantsJson: '[]' },
        resolveRootShape: { effectiveFolderId: 'f1', rootOwnerId: null },
      },
    })
    expect(out.allowed).toBe(true)
    expect(out.grants).toEqual([{ principalId: 'anyone', principalEmail: null, principalName: null, level: 'view' }])
  })

  it('behaviorally: replacing an existing anyone grant with stale principalEmail still nulls it', () => {
    const handler = compileHandler(mergeCode) as (ctx: any) => any
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
    expect(out.grants).toEqual([{ principalId: 'anyone', principalEmail: null, principalName: null, level: 'view' }])
  })
})

/**
 * Task 4: grants CRUD carries the group-principal display metadata the UI (Task 7) needs.
 * Evaluation (acl.ts / evalAccess) never reads these — they are display-only fields stored
 * alongside principalId/level and echoed verbatim by the GET shape.
 */
describe('grants API round-trips group principal metadata (Task 4)', () => {
  const grantsPost = proxy.rules.find((r) => r.pathPattern === '/api/grants' && r.method === 'POST')!
  const mergeStep = grantsPost.pipelineConfig.steps.find((s: any) => s.id === 'merge')
  const mergeCode: string = mergeStep.config.code

  const grantsGet = proxy.rules.find((r) => r.pathPattern === '/api/grants' && r.method === 'GET')!
  const shapeStep = grantsGet.pipelineConfig.steps.find((s: any) => s.id === 'shape')
  const shapeCode: string = shapeStep.config.code

  const merge = (body: any, folder: any) =>
    (compileHandler(mergeCode) as (ctx: any) => any)({
      user: { id: 'owner-1', role: 'admin' },
      request: { body },
      steps: {
        folder,
        resolveRootShape: { effectiveFolderId: 'f1', rootOwnerId: null },
      },
    })

  // shape.fn.ts is owner/admin-gated (issue #266) — these tests are about the display-metadata
  // shaping, not the gate, so run as the folder's owner to clear it.
  const shape = (grants: unknown[]) =>
    (compileHandler(shapeCode) as (ctx: any) => any)({
      user: { id: 'owner-1', role: 'user' },
      steps: { folder: { ownerId: 'owner-1', grantsJson: JSON.stringify(grants) } },
    })

  it('POST stores principalType/principalName for a new group grant; GET echoes them', () => {
    const mergeOut = merge(
      { folderId: 'f1', principalId: 'group-1', principalType: 'group', principalName: 'Design', level: 'edit' },
      { id: 'f1', ownerId: 'owner-1', grantsJson: '[]' },
    )
    expect(mergeOut.allowed).toBe(true)
    expect(mergeOut.grants).toEqual([
      {
        principalId: 'group-1',
        principalEmail: null,
        principalType: 'group',
        principalName: 'Design',
        level: 'edit',
      },
    ])

    const shapeOut = shape(mergeOut.grants)
    expect(shapeOut.grants).toEqual([
      {
        principalId: 'group-1',
        principalEmail: null,
        principalType: 'group',
        principalName: 'Design',
        level: 'edit',
      },
    ])
  })

  it('sanitizes any non-"group" principalType to undefined and drops the name', () => {
    const out = merge(
      { folderId: 'f1', principalId: 'u1', principalType: 'role', principalName: 'X', level: 'view' },
      { id: 'f1', ownerId: 'owner-1', grantsJson: '[]' },
    )
    expect(out.grants[0].principalType).toBeUndefined()
    expect(out.grants[0].principalName).toBeNull()
  })

  it('a legacy stored grant without principalType shapes with it absent (not rewritten to "user")', () => {
    const out = shape([{ principalId: 'u1', principalEmail: 'u1@example.com', level: 'view' }])
    expect(out.grants).toEqual([
      { principalId: 'u1', principalEmail: 'u1@example.com', level: 'view', principalName: null },
    ])
    expect(out.grants[0].principalType).toBeUndefined()
  })

  it('an anyone POST still forces level view, no email, and now no name/group type', () => {
    const out = merge(
      {
        folderId: 'f1',
        principalId: 'anyone',
        principalType: 'group',
        principalName: 'Everyone',
        level: 'edit',
      },
      { id: 'f1', ownerId: 'owner-1', grantsJson: '[]' },
    )
    expect(out.grants).toEqual([{ principalId: 'anyone', principalEmail: null, level: 'view', principalName: null }])
    expect(out.grants[0].principalType).toBeUndefined()
  })

  it('preserves stored principalType/principalName on update when the body omits them', () => {
    const out = merge(
      { folderId: 'f1', principalId: 'group-1', level: 'view' },
      {
        id: 'f1',
        ownerId: 'owner-1',
        grantsJson: JSON.stringify([
          {
            principalId: 'group-1',
            principalEmail: null,
            principalType: 'group',
            principalName: 'Design',
            level: 'edit',
          },
        ]),
      },
    )
    expect(out.grants).toEqual([
      {
        principalId: 'group-1',
        principalEmail: null,
        principalType: 'group',
        principalName: 'Design',
        level: 'view',
      },
    ])
  })

  it('sanitizes a garbage stored principalType on update when the body omits it', () => {
    const out = merge(
      { folderId: 'f1', principalId: 'group-1', level: 'view' },
      {
        id: 'f1',
        ownerId: 'owner-1',
        grantsJson: JSON.stringify([
          {
            principalId: 'group-1',
            principalEmail: null,
            principalType: 'admin',
            principalName: 'Design',
            level: 'edit',
          },
        ]),
      },
    )
    expect(out.grants[0].principalType).toBeUndefined()
  })

  it('a new principalName in the body wins over the stored name on update', () => {
    const out = merge(
      { folderId: 'f1', principalId: 'group-1', principalType: 'group', principalName: 'Engineering', level: 'view' },
      {
        id: 'f1',
        ownerId: 'owner-1',
        grantsJson: JSON.stringify([
          {
            principalId: 'group-1',
            principalEmail: null,
            principalType: 'group',
            principalName: 'Design',
            level: 'edit',
          },
        ]),
      },
    )
    expect(out.grants).toEqual([
      {
        principalId: 'group-1',
        principalEmail: null,
        principalType: 'group',
        principalName: 'Engineering',
        level: 'view',
      },
    ])
  })
})
