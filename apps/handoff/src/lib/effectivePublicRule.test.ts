// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard + behavioral test for the `root: {id, public}` listing
 * meta (effective Public/Private UI, task 2). Extracts the REAL embedded
 * `shape` step and `response` step from the /api/nodes GET rule and runs
 * the shape handler (via `new Function`, same idiom as anyoneGrantRule.test.ts)
 * against fixtures.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules } from '../test/proxyRules'

const proxy = await loadProxyRules()

const nodesGetRule = proxy.rules.find((r) => r.pathPattern === '/api/nodes' && r.method === 'GET')!
const shapeStep = nodesGetRule.pipelineConfig.steps.find((s: any) => s.id === 'shape')
const responseStep = nodesGetRule.pipelineConfig.steps.find((s: any) => s.id === 'response')
const shapeCode: string = shapeStep.config.code

describe('GET /api/nodes response carries root {id, public} meta (structural)', () => {
  it('response step body includes both nodes and root', () => {
    expect(responseStep.config.body).toBe(
      '{"nodes": {{{steps.shape.nodes}}}, "root": {{{steps.shape.rootMeta}}}}',
    )
  })

  it('shape step returns rootMeta alongside nodes', () => {
    expect(shapeCode).toContain('rootMeta')
    expect(shapeCode.trim().endsWith('return { nodes: out, rootMeta: { id: rootId, public: rootPublic } }; }')).toBe(
      true,
    )
  })
})

describe('GET /api/nodes shape handler (behavioral)', () => {
  const handler = new Function(`return (${shapeCode})`)() as (ctx: {
    steps: {
      allFolders: any[]
      query: any[]
      gate: { viewer: any }
    }
  }) => { nodes: any[]; rootMeta: { id: string | null; public: boolean } }

  const rootRecord = (grantsJson: string) => ({
    id: 'root-1',
    nodeType: 'root',
    parentId: null,
    ownerId: 'owner-1',
    grantsJson,
    mode: 'inheriting',
    displayName: 'Root',
  })

  const folderRecord = {
    id: 'f1',
    nodeType: 'folder',
    parentId: 'root',
    ownerId: 'owner-1',
    grantsJson: '[]',
    mode: 'inheriting',
    displayName: 'Docs',
  }

  const folderRow = {
    id: 'f1',
    nodeType: 'folder',
    parentId: 'root',
    ownerId: 'owner-1',
    grantsJson: '[]',
    mode: 'inheriting',
    displayName: 'Docs',
    createdMs: 1000,
  }

  it('(b) root has an anyone grant (grantsJson as a JSON string) -> rootMeta.public true, nodes still listed', () => {
    const out = handler({
      steps: {
        allFolders: [rootRecord(JSON.stringify([{ principalId: 'anyone', level: 'view' }])), folderRecord],
        query: [folderRow],
        gate: { viewer: { isAdmin: true } },
      },
    })
    expect(out.rootMeta).toEqual({ id: 'root-1', public: true })
    expect(out.nodes).toHaveLength(1)
    expect(out.nodes[0].id).toBe('f1')
  })

  it('(c) root grants is an empty JSON-string array -> rootMeta.public false', () => {
    const out = handler({
      steps: {
        allFolders: [rootRecord('[]'), folderRecord],
        query: [folderRow],
        gate: { viewer: { isAdmin: true } },
      },
    })
    expect(out.rootMeta).toEqual({ id: 'root-1', public: false })
  })

  it('(d) no root record present -> rootMeta { id: null, public: false }', () => {
    const out = handler({
      steps: {
        allFolders: [folderRecord],
        query: [folderRow],
        gate: { viewer: { isAdmin: true } },
      },
    })
    expect(out.rootMeta).toEqual({ id: null, public: false })
  })
})

/**
 * PATCH /api/node — set a folder's inheritance mode (task 3). Structural
 * guard on the 7-step pipeline plus behavioral execution of the real
 * embedded `pre` and `check` function_handler steps (new Function, same
 * idiom as anyoneGrantRule.test.ts / the shape-handler tests above).
 */
describe('PATCH /api/node (structural)', () => {
  const rule = proxy.rules.find((r) => r.pathPattern === '/api/node' && r.method === 'PATCH')!

  it('exists at /api/node PATCH with the step ids in order (field-scoped saves)', () => {
    expect(rule).toBeTruthy()
    expect(rule.order).toBe(31)
    expect(rule.pipelineConfig.steps.map((s: any) => s.id)).toEqual([
      'pre',
      'folder',
      'check',
      // #191: mode and feedExcluded each get their own conditional data_update so
      // a field-disjoint write never clobbers the other (see #194).
      'saveMode',
      'saveFeedExcluded',
      'ok',
      'bad',
      'denied',
    ])
  })

  it('saveMode writes only mode, saveFeedExcluded writes only feedExcluded', () => {
    const saveMode = rule.pipelineConfig.steps.find((s: any) => s.id === 'saveMode')
    const saveFe = rule.pipelineConfig.steps.find((s: any) => s.id === 'saveFeedExcluded')
    expect(saveMode.config.fields).toEqual({ mode: 'steps.pre.mode' })
    expect(saveMode.config.condition).toBe('steps.check.saveMode')
    expect(saveFe.config.fields).toEqual({ feedExcluded: 'steps.pre.feedExcluded' })
    expect(saveFe.config.condition).toBe('steps.check.saveFeedExcluded')
  })
})

describe('PATCH /api/node pre + check handlers (behavioral)', () => {
  const rule = proxy.rules.find((r) => r.pathPattern === '/api/node' && r.method === 'PATCH')!
  const preCode: string = rule.pipelineConfig.steps.find((s: any) => s.id === 'pre').config.code
  const checkCode: string = rule.pipelineConfig.steps.find((s: any) => s.id === 'check').config.code

  const pre = new Function(`return (${preCode})`)() as (ctx: {
    request: { body: Record<string, unknown> }
    user: { id: string; role?: string } | null
  }) => {
    id: string
    mode: string
    hasMode: boolean
    hasFeedExcluded: boolean
    feedExcluded: boolean
    valid: boolean
    isAdmin: boolean
    uid: string | null
  }

  const check = new Function(`return (${checkCode})`)() as (ctx: {
    steps: { pre: any; folder: any }
  }) => { allowed: boolean; badRequest: boolean; denied: boolean; saveMode: boolean; saveFeedExcluded: boolean }

  const FOLDER_ID = '11111111-1111-1111-1111-111111111111'
  const folderRec = { id: FOLDER_ID, nodeType: 'folder', ownerId: 'owner-1' }
  const rootRec = { id: FOLDER_ID, nodeType: 'root', ownerId: 'owner-1' }

  function run(
    user: { id: string; role?: string } | null,
    folder: any,
    body: Record<string, unknown> = { id: FOLDER_ID, mode: 'restricted' },
  ) {
    const preOut = pre({ request: { body }, user })
    const checkOut = check({ steps: { pre: preOut, folder } })
    return { preOut, checkOut }
  }

  it('owner + folder (mode) -> allowed, saveMode only', () => {
    const { checkOut } = run({ id: 'owner-1', role: 'user' }, folderRec)
    expect(checkOut).toEqual({ allowed: true, badRequest: false, denied: false, saveMode: true, saveFeedExcluded: false })
  })

  it('admin + folder (mode) -> allowed', () => {
    const { checkOut } = run({ id: 'someone-else', role: 'admin' }, folderRec)
    expect(checkOut).toEqual({ allowed: true, badRequest: false, denied: false, saveMode: true, saveFeedExcluded: false })
  })

  it('feedExcluded-only PATCH -> allowed, saveFeedExcluded only (no mode clobber)', () => {
    const { preOut, checkOut } = run({ id: 'owner-1', role: 'user' }, folderRec, {
      id: FOLDER_ID,
      feedExcluded: true,
    })
    expect(preOut.valid).toBe(true)
    expect(preOut.feedExcluded).toBe(true)
    // A feedExcluded write must NOT trigger the mode save — that field stays put.
    expect(checkOut).toEqual({ allowed: true, badRequest: false, denied: false, saveMode: false, saveFeedExcluded: true })
  })

  it('mode-only PATCH -> saveFeedExcluded false (no feedExcluded clobber)', () => {
    const { checkOut } = run({ id: 'owner-1', role: 'user' }, folderRec, { id: FOLDER_ID, mode: 'inheriting' })
    expect(checkOut.saveMode).toBe(true)
    expect(checkOut.saveFeedExcluded).toBe(false)
  })

  it('non-owner user -> denied (not badRequest)', () => {
    const { checkOut } = run({ id: 'other-user', role: 'user' }, folderRec)
    expect(checkOut).toEqual({ allowed: false, badRequest: false, denied: true, saveMode: false, saveFeedExcluded: false })
  })

  it('anonymous (user null) -> denied', () => {
    const { checkOut } = run(null, folderRec)
    expect(checkOut).toEqual({ allowed: false, badRequest: false, denied: true, saveMode: false, saveFeedExcluded: false })
  })

  it("nodeType 'root' target -> badRequest", () => {
    const { checkOut } = run({ id: 'owner-1', role: 'user' }, rootRec)
    expect(checkOut).toEqual({ allowed: false, badRequest: true, denied: false, saveMode: false, saveFeedExcluded: false })
  })

  it('empty body (neither mode nor feedExcluded) -> badRequest', () => {
    const { checkOut } = run({ id: 'owner-1', role: 'user' }, folderRec, { id: FOLDER_ID })
    expect(checkOut).toEqual({ allowed: false, badRequest: true, denied: false, saveMode: false, saveFeedExcluded: false })
  })

  it('bad mode value (no feedExcluded) -> badRequest', () => {
    const { checkOut } = run({ id: 'owner-1', role: 'user' }, folderRec, { id: FOLDER_ID, mode: 'bogus' })
    expect(checkOut).toEqual({ allowed: false, badRequest: true, denied: false, saveMode: false, saveFeedExcluded: false })
  })

  it('non-uuid id -> badRequest', () => {
    const { checkOut } = run({ id: 'owner-1', role: 'user' }, folderRec, { id: 'not-a-uuid', mode: 'restricted' })
    expect(checkOut).toEqual({ allowed: false, badRequest: true, denied: false, saveMode: false, saveFeedExcluded: false })
  })
})
