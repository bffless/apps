// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Behavioral guard for the GET /api/nodes `gate` step (group-sharing, Task 3).
 *
 * `rules/api/nodes/get/gate.fn.ts` builds a `Viewer` from `user` and evaluates it against the
 * requested parent's folder chain via the shared `evalAccess`. `evalAccess` itself already
 * matches group grants (Task 2, pinned by `anyoneGrantRule.test.ts` and `acl.test.ts`) — this
 * suite pins that the gate actually *threads* `user.groups` into `viewer.groupIds` so a group
 * grant reaches this decision at all. No suite previously ran this gate with a real `user`
 * object (existing `/api/nodes` coverage bypasses it via `steps.gate.viewer` fixtures), so this
 * is new coverage, not an extension of an existing file.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'

const proxy = await loadProxyRules()

const rule = proxy.rules.find((r) => r.pathPattern === '/api/nodes' && r.method === 'GET')
const step = (id: string) => rule!.pipelineConfig.steps.find((s: any) => s.id === id)

const gate = compileHandler(step('gate').config.code)

const FOLDER = '00000000-0000-4000-8000-0000000000b1'

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

/** Run the gate on a non-root parent listing request, as `user`. */
function runGate(opts: {
  user?: { id: string; role?: string; groups?: string[] } | null
  folders?: Record<string, any>[]
}): Record<string, any> {
  return gate({
    user: opts.user ?? null,
    request: { headers: {} },
    utils: { verify: () => false, base64urlDecode: (v: string) => v },
    steps: {
      pre: { isRoot: false, parentId: FOLDER },
      allFolders: opts.folders ?? [folderRow()],
    },
  })
}

describe('handoff GET /api/nodes gate (group grants)', () => {
  it('a member of the granted group is allowed', () => {
    const out = runGate({
      user: { id: 'u2', role: 'user', groups: ['group-1'] },
      folders: [folderRow([{ principalId: 'group-1', principalType: 'group', level: 'view' }])],
    })
    expect(out).toMatchObject({ allow: true, deny401: false, deny403: false })
  })

  it('a non-member (empty groups) is denied', () => {
    const out = runGate({
      user: { id: 'u2', role: 'user', groups: [] },
      folders: [folderRow([{ principalId: 'group-1', principalType: 'group', level: 'view' }])],
    })
    expect(out).toMatchObject({ allow: false, deny401: false, deny403: true })
  })

  it('an authenticated user with no `groups` field at all (pre-release CE) does not throw and is denied', () => {
    const out = runGate({
      user: { id: 'u2', role: 'user' },
      folders: [folderRow([{ principalId: 'group-1', principalType: 'group', level: 'view' }])],
    })
    expect(out).toMatchObject({ allow: false, deny401: false, deny403: true })
  })
})
