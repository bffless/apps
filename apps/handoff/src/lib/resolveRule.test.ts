// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural + behavioral guard for GET /api/resolve/* (path-URLs spec,
 * 2026-07-06): resolves a decoded content path to a node under the SAME ACL
 * gate as the serve rule, so /tree//blob deep links work for owners, nested
 * grantees, and share visitors. Runs the real embedded handlers.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules } from '../test/proxyRules'

const NODES_SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'

const proxy = await loadProxyRules()

const rule = proxy.rules.find((r) => r.pathPattern === '/api/resolve/*')

function handlerOf(stepId: string): (ctx: any) => any {
  const step = rule!.pipelineConfig.steps.find((s: any) => s.id === stepId)
  return new Function(`return (${step.config.code})`)() as (ctx: any) => any
}

const FOLDER_A = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  nodeType: 'folder',
  displayName: 'Test',
  parentId: 'root',
  ownerId: 'owner-1',
  mode: 'inheriting',
  grantsJson: '[]',
}
const FOLDER_B = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  nodeType: 'folder',
  displayName: 'Sub Folder',
  parentId: FOLDER_A.id,
  ownerId: 'owner-1',
  mode: 'inheriting',
  grantsJson: JSON.stringify([{ principalId: 'grantee-1', level: 'view' }]),
}
const FILE_C = {
  id: 'cccccccc-0000-4000-8000-000000000003',
  nodeType: 'file',
  displayName: 'My File.png',
  parentId: FOLDER_B.id,
  ownerId: 'owner-1',
  url: '/api/uploads/content/Test/Sub Folder/My File.png',
  storage_path: 'bffless/apps/uploads/content/Test/Sub Folder/My File.png',
  createdMs: 1,
  size: 10,
}

describe('GET /api/resolve/* — structure', () => {
  it('exists as an enabled GET pipeline rule against the nodes schema', () => {
    expect(rule).toBeTruthy()
    expect(rule!.proxyType).toBe('pipeline')
    expect(rule!.isEnabled).toBe(true)
    expect(rule!.method).toBe('GET')
    const nodeByKey = rule!.pipelineConfig.steps.find((s: any) => s.id === 'nodeByKey')
    expect(nodeByKey.handlerType).toBe('data_query')
    expect(nodeByKey.config.schemaId).toBe(NODES_SCHEMA)
    expect(nodeByKey.config.filters.storage_path.value).toBe('steps.parse.fullKey')
    const respond = rule!.pipelineConfig.steps.find((s: any) => s.id === 'respond')
    expect(respond.handlerType).toBe('response_handler')
    expect(respond.config.condition).toBe('steps.gate.allow')
  })
})

describe('parse step — per-segment decode', () => {
  it('decodes spaces/U+202F and builds the full storage key', () => {
    const parse = handlerOf('parse')
    const out = parse({
      request: { path: '/api/resolve/Test/Sub%20Folder/My%20File.png' },
      deployment: { owner: 'bffless', repo: 'apps' },
    })
    expect(out.path).toBe('Test/Sub Folder/My File.png')
    expect(out.segments).toEqual(['Test', 'Sub Folder', 'My File.png'])
    expect(out.fullKey).toBe('bffless/apps/uploads/content/Test/Sub Folder/My File.png')
    expect(out.hasPath).toBe(true)
  })

  it('keeps a malformed escape raw and rejects dot segments', () => {
    const parse = handlerOf('parse')
    const raw = parse({
      request: { path: '/api/resolve/Test/100%zz.png' },
      deployment: { owner: 'o', repo: 'r' },
    })
    expect(raw.path).toBe('Test/100%zz.png')
    expect(raw.hasPath).toBe(true)
    const dots = parse({
      request: { path: '/api/resolve/Test/../secret' },
      deployment: { owner: 'o', repo: 'r' },
    })
    expect(dots.hasPath).toBe(false)
  })
})

describe('gate step — resolution + ACL', () => {
  function runGate(opts: {
    user?: { id: string; role?: string } | null
    parse: any
    nodeByKey?: any[]
    request?: any
    utils?: any
  }) {
    const gate = handlerOf('gate')
    return gate({
      user: opts.user ?? null,
      request: opts.request ?? { headers: {} },
      utils: opts.utils ?? { verify: () => false, base64urlDecode: () => '' },
      steps: {
        parse: opts.parse,
        nodeByKey: opts.nodeByKey ?? [],
        allFolders: [FOLDER_A, FOLDER_B],
      },
    })
  }
  const fileParse = {
    path: 'Test/Sub Folder/My File.png',
    segments: ['Test', 'Sub Folder', 'My File.png'],
    fullKey: 'bffless/apps/uploads/content/Test/Sub Folder/My File.png',
    hasPath: true,
  }
  const folderParse = {
    path: 'Test/Sub Folder',
    segments: ['Test', 'Sub Folder'],
    fullKey: 'bffless/apps/uploads/content/Test/Sub Folder',
    hasPath: true,
  }
  const rootFolderParse = {
    path: 'Test',
    segments: ['Test'],
    fullKey: 'bffless/apps/uploads/content/Test',
    hasPath: true,
  }

  it('resolves a file for its owner with a full node shape', () => {
    const out = runGate({ user: { id: 'owner-1' }, parse: fileParse, nodeByKey: [FILE_C] })
    expect(out.allow).toBe(true)
    expect(out.node.id).toBe(FILE_C.id)
    expect(out.node.type).toBe('file')
    expect(out.node.path).toBe('Test/Sub Folder/My File.png')
    expect(out.node.url).toBe(FILE_C.url)
  })

  it('resolves a nested folder by name-walk for a grantee who cannot see the ancestor', () => {
    const out = runGate({ user: { id: 'grantee-1' }, parse: folderParse })
    expect(out.allow).toBe(true)
    expect(out.node.id).toBe(FOLDER_B.id)
    expect(out.node.type).toBe('folder')
    expect(out.node.path).toBe('Test/Sub Folder')
  })

  it('denies the same nested folder to a stranger with 403 and to anon with 401', () => {
    const stranger = runGate({ user: { id: 'someone-else' }, parse: folderParse })
    expect(stranger.allow).toBe(false)
    expect(stranger.deny403).toBe(true)
    const anon = runGate({ user: null, parse: folderParse })
    expect(anon.allow).toBe(false)
    expect(anon.deny401).toBe(true)
  })

  it('404s an unresolvable path', () => {
    const out = runGate({
      user: { id: 'owner-1' },
      parse: { path: 'Nope/missing', segments: ['Nope', 'missing'], fullKey: 'bffless/apps/uploads/content/Nope/missing', hasPath: true },
    })
    expect(out.allow).toBe(false)
    expect(out.deny404).toBe(true)
  })

  it('treats a dot-segment path as unresolved (404) even when a valid prefix exists', () => {
    const out = runGate({
      user: { id: 'owner-1' },
      parse: {
        path: 'Test',
        segments: ['Test'],
        fullKey: 'bffless/apps/uploads/content/Test',
        hasPath: false,
      },
    })
    expect(out.allow).toBe(false)
    expect(out.deny404).toBe(true)
    expect(out.deny403).toBe(false)
  })

  it('resolves for a share visitor (hf_s cookie) within scope, and denies (403) outside scope', () => {
    const shareRequest = { headers: { cookie: 'hf_s=body.sig' } }
    const shareUtils = {
      verify: () => true,
      base64urlDecode: () => JSON.stringify({ s: FOLDER_B.id, exp: Date.now() + 60_000 }),
    }
    const inScope = runGate({
      user: null,
      parse: folderParse,
      request: shareRequest,
      utils: shareUtils,
    })
    expect(inScope.allow).toBe(true)
    expect(inScope.level).toBe('view')

    const outOfScope = runGate({
      user: null,
      parse: rootFolderParse,
      request: shareRequest,
      utils: shareUtils,
    })
    expect(outOfScope.allow).toBe(false)
    expect(outOfScope.deny403).toBe(true)
  })
})
