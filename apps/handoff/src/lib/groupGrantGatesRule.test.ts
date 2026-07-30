// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Behavioral guard for group-grant threading (group-sharing, Task 3) on the three gates that,
 * before this suite, had no test running the real gate function with a `user` object:
 * `GET /api/node`, `PATCH /api/node/meta`, and `POST /api/sign`. Each gate builds a `Viewer`
 * from `user` and hands it to the shared `evalAccess` (already group-aware, Task 2) — this pins
 * that `user.groups` actually reaches `viewer.groupIds` at each of these three sites, the same
 * way `nodesListGateRule.test.ts` pins it for `GET /api/nodes`.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'

const proxy = await loadProxyRules()

function step(pathPattern: string, method: string, stepId: string) {
  const rule = proxy.rules.find((r) => r.pathPattern === pathPattern && r.method === method)
  if (!rule) throw new Error(`no rule for ${method} ${pathPattern}`)
  const s = rule.pipelineConfig.steps.find((x: any) => x.id === stepId)
  if (!s) throw new Error(`${method} ${pathPattern} has no "${stepId}" step`)
  return compileHandler(s.config.code)
}

const utils = { verify: () => false, base64urlDecode: (v: string) => v }
const FOLDER = '00000000-0000-4000-8000-0000000000b1'
const groupGrant = (level: string) => [{ principalId: 'group-1', principalType: 'group', level }]
const folderRow = (grants: unknown[]) => ({
  id: FOLDER,
  nodeType: 'folder',
  parentId: 'root',
  ownerId: 'alice',
  grantsJson: JSON.stringify(grants),
  mode: 'inheriting',
  displayName: 'Docs',
})

describe('GET /api/node gate (group grants)', () => {
  const gate = step('/api/node', 'GET', 'gate')
  const runGate = (user: any) =>
    gate({
      user,
      request: { headers: {} },
      utils,
      steps: { allFolders: [folderRow(groupGrant('view'))], query: folderRow(groupGrant('view')) },
    }) as Record<string, any>

  it('a member of the granted group is allowed', () => {
    const out = runGate({ id: 'u2', role: 'user', groups: ['group-1'] })
    expect(out).toMatchObject({ allow: true, deny401: false, deny403: false })
  })

  it('a non-member is denied', () => {
    const out = runGate({ id: 'u2', role: 'user', groups: ['group-2'] })
    expect(out).toMatchObject({ allow: false, deny401: false, deny403: true })
  })
})

describe('PATCH /api/node/meta gate (group grants)', () => {
  const gate = step('/api/node/meta', 'PATCH', 'gate')
  const LEAF = '00000000-0000-4000-8000-0000000000f1'
  const leaf = { id: LEAF, nodeType: 'file', parentId: FOLDER, ownerId: 'alice' }
  const runGate = (user: any) =>
    gate({
      user,
      request: { headers: {} },
      utils,
      steps: {
        pre: { idOk: true, hasField: true, hasTitle: true, hasDescription: false },
        allFolders: [folderRow(groupGrant('edit'))],
        query: leaf,
      },
    }) as Record<string, any>

  it('a member of the granted (edit) group may save', () => {
    const out = runGate({ id: 'u2', role: 'user', groups: ['group-1'] })
    expect(out).toMatchObject({ badRequest: false, deny401: false, deny403: false, doSave: true })
  })

  it('a non-member is denied', () => {
    const out = runGate({ id: 'u2', role: 'user', groups: ['group-2'] })
    expect(out).toMatchObject({ badRequest: false, deny401: false, deny403: true, doSave: false })
  })
})

describe('POST /api/sign gate (group grants)', () => {
  const gate = step('/api/sign', 'POST', 'gate')
  const KEY_FILE = { id: '00000000-0000-4000-8000-0000000000f2', parentId: FOLDER, ownerId: 'alice' }
  const runGate = (user: any) =>
    gate({
      user,
      request: { headers: {} },
      utils,
      steps: { allFolders: [folderRow(groupGrant('view'))], nodeByKey: [KEY_FILE] },
    }) as Record<string, any>

  it('a member of the granted group is allowed to sign', () => {
    const out = runGate({ id: 'u2', role: 'user', groups: ['group-1'] })
    expect(out).toMatchObject({ allow: true, deny401: false, deny403: false })
  })

  it('a non-member is denied', () => {
    const out = runGate({ id: 'u2', role: 'user', groups: ['group-2'] })
    expect(out).toMatchObject({ allow: false, deny401: false, deny403: true })
  })
})
