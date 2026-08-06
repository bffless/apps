// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the create-endpoint write gate.
 *
 * The four creation endpoints shipped with no access check at all, so an unauthenticated
 * caller could create nodes (with `ownerId: null`) and any authenticated user could create
 * inside a folder they held no access to. `decideWrite` is the missing check; this pins its
 * decision table, including the 401-vs-403 split that tells a caller whether the problem is
 * a missing credential or an insufficient one.
 */
import { describe, it, expect } from 'vitest'
import { decideWrite, viewerFrom } from '../../.bffless/proxy-rules/handoff/_shared/writeAccess'
import type { NodeRow } from '../../.bffless/proxy-rules/handoff/_shared/acl'

const ROOT: NodeRow = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  nodeType: 'root',
  parentId: '',
  ownerId: 'owner-1',
  mode: 'inheriting',
  grantsJson: '[]',
}

const FOLDER_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

function folder(over: Partial<NodeRow> = {}): NodeRow {
  return {
    id: FOLDER_ID,
    nodeType: 'folder',
    displayName: 'Docs',
    parentId: 'root',
    ownerId: 'owner-1',
    mode: 'inheriting',
    grantsJson: '[]',
    ...over,
  }
}

const tree = (over: Partial<NodeRow> = {}) => [ROOT, folder(over)]

describe('decideWrite — root', () => {
  it('allows any authenticated user', () => {
    const d = decideWrite({ folders: tree(), parentId: 'root', viewer: { userId: 'nobody' } })
    expect(d.allow).toBe(true)
    expect(d.deny401).toBe(false)
    expect(d.deny403).toBe(false)
  })

  it('treats an absent parentId as root', () => {
    expect(decideWrite({ folders: tree(), parentId: '', viewer: { userId: 'nobody' } }).allow).toBe(true)
  })

  it('denies an anonymous caller with 401', () => {
    const d = decideWrite({ folders: tree(), parentId: 'root', viewer: {} })
    expect(d.allow).toBe(false)
    expect(d.deny401).toBe(true)
    expect(d.deny403).toBe(false)
  })

  it('denies a share-link visitor with 403 — a credential was presented, it just cannot write', () => {
    const d = decideWrite({ folders: tree(), parentId: 'root', viewer: { shareLinkFolderId: FOLDER_ID } })
    expect(d.allow).toBe(false)
    expect(d.deny401).toBe(false)
    expect(d.deny403).toBe(true)
  })
})

describe('decideWrite — folder', () => {
  it('allows the owner', () => {
    expect(decideWrite({ folders: tree(), parentId: FOLDER_ID, viewer: { userId: 'owner-1' } }).allow).toBe(true)
  })

  it('allows an admin', () => {
    expect(
      decideWrite({ folders: tree(), parentId: FOLDER_ID, viewer: { userId: 'x', isAdmin: true } }).allow,
    ).toBe(true)
  })

  it('allows an edit grantee', () => {
    const folders = tree({ grantsJson: JSON.stringify([{ principalId: 'bob', level: 'edit' }]) })
    expect(decideWrite({ folders, parentId: FOLDER_ID, viewer: { userId: 'bob' } }).allow).toBe(true)
  })

  it('denies a view-only grantee with 403', () => {
    const folders = tree({ grantsJson: JSON.stringify([{ principalId: 'carol', level: 'view' }]) })
    const d = decideWrite({ folders, parentId: FOLDER_ID, viewer: { userId: 'carol' } })
    expect(d.allow).toBe(false)
    expect(d.deny403).toBe(true)
  })

  it('denies a signed-in non-grantee with 403', () => {
    const d = decideWrite({ folders: tree(), parentId: FOLDER_ID, viewer: { userId: 'stranger' } })
    expect(d.allow).toBe(false)
    expect(d.deny403).toBe(true)
  })

  it('denies an anonymous caller with 401', () => {
    const d = decideWrite({ folders: tree(), parentId: FOLDER_ID, viewer: {} })
    expect(d.allow).toBe(false)
    expect(d.deny401).toBe(true)
  })

  it('never lets an anyone-grant reach edit — publicness cannot escalate to write', () => {
    const folders = tree({ grantsJson: JSON.stringify([{ principalId: 'anyone', level: 'edit' }]) })
    expect(decideWrite({ folders, parentId: FOLDER_ID, viewer: {} }).allow).toBe(false)
    expect(decideWrite({ folders, parentId: FOLDER_ID, viewer: { userId: 'stranger' } }).allow).toBe(false)
  })

  it('denies an unknown parentId rather than falling through', () => {
    const d = decideWrite({
      folders: tree(),
      parentId: 'ffffffff-0000-4000-8000-00000000000f',
      viewer: { userId: 'stranger' },
    })
    expect(d.allow).toBe(false)
    expect(d.deny403).toBe(true)
  })
})

describe('viewerFrom', () => {
  const utils = { verify: () => false, base64urlDecode: () => '' }

  it('builds a user viewer from the pipeline user, carrying groups and admin', () => {
    const v = viewerFrom({
      user: { id: 'u1', role: 'admin', groups: ['g1'] },
      request: { headers: {} },
      utils,
    } as any)
    expect(v).toEqual({ userId: 'u1', isAdmin: true, groupIds: ['g1'] })
  })

  it('is anonymous with no user and no valid share cookie', () => {
    expect(viewerFrom({ user: null, request: { headers: {} }, utils } as any)).toEqual({})
  })

  it('ignores a share cookie whose signature does not verify', () => {
    const req = { headers: { cookie: 'hf_s=body.badsig' } }
    expect(viewerFrom({ user: null, request: req, utils } as any)).toEqual({})
  })

  it('reads a valid, unexpired share cookie as a share viewer', () => {
    const payload = { s: FOLDER_ID, exp: Date.now() + 60_000 }
    const shareUtils = {
      verify: () => true,
      base64urlDecode: () => JSON.stringify(payload),
    }
    const req = { headers: { cookie: 'hf_s=body.sig' } }
    expect(viewerFrom({ user: null, request: req, utils: shareUtils } as any)).toEqual({
      shareLinkFolderId: FOLDER_ID,
    })
  })
})
