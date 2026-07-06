// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Behavioral guard: the GET /api/nodes and GET /api/node shape steps emit a
 * server-computed `path` for every node (folders included) so the app can
 * build /tree//blob URLs without walking ancestors client-side (path-URLs
 * spec, 2026-07-06). Runs the real embedded handlers.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

const listRule = proxy.rules.find((r) => r.pathPattern === '/api/nodes' && r.method === 'GET')
const nodeRule = proxy.rules.find((r) => r.pathPattern === '/api/node' && r.method === 'GET')

function handlerOf(rule: Record<string, any>, stepId: string): (ctx: any) => any {
  const step = rule.pipelineConfig.steps.find((s: any) => s.id === stepId)
  return new Function(`return (${step.config.code})`)() as (ctx: any) => any
}

// Two nested folders + one file, as flattened data_query rows.
const FOLDER_A = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  nodeType: 'folder',
  displayName: 'Test',
  parentId: 'root',
  ownerId: 'u1',
  mode: 'inheriting',
}
const FOLDER_B = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  nodeType: 'folder',
  displayName: 'Sub Folder',
  parentId: FOLDER_A.id,
  ownerId: 'u1',
  mode: 'inheriting',
}
const FILE_C = {
  id: 'cccccccc-0000-4000-8000-000000000003',
  nodeType: 'file',
  displayName: 'My File.png',
  parentId: FOLDER_B.id,
  ownerId: 'u1',
  url: '/api/uploads/content/Test/Sub Folder/My File.png',
  storage_path: 'bffless/apps/uploads/content/Test/Sub Folder/My File.png',
  createdMs: 1,
  size: 10,
}
// A Site: url ends in the entry file, but storage_path is the dir prefix — the
// path must derive from storage_path (what GET /api/resolve/* matches), not
// from stripping the CONTENT prefix off url (which would wrongly include the
// entry filename).
const SITE_D = {
  id: 'dddddddd-0000-4000-8000-000000000004',
  nodeType: 'site',
  displayName: 'My Site',
  parentId: FOLDER_A.id,
  ownerId: 'u1',
  siteEntry: 'index.html',
  url: '/api/uploads/content/Test/My Site/index.html',
  storage_path: 'bffless/apps/uploads/content/Test/My Site',
  createdMs: 2,
  size: 0,
}

describe('GET /api/nodes shape step — node.path', () => {
  it('emits folder paths from ancestor names and file paths from the content url', () => {
    const shape = handlerOf(listRule!, 'shape')
    const out = shape({
      steps: {
        allFolders: [FOLDER_A, FOLDER_B],
        gate: { viewer: { userId: 'u1', isAdmin: false } },
        query: [FOLDER_B, FILE_C],
      },
    })
    const byName = Object.fromEntries(out.nodes.map((n: any) => [n.name, n]))
    expect(byName['Sub Folder'].path).toBe('Test/Sub Folder')
    expect(byName['My File.png'].path).toBe('Test/Sub Folder/My File.png')
  })

  it('emits a Site path from storage_path (dir prefix), not from the entry-suffixed url', () => {
    const shape = handlerOf(listRule!, 'shape')
    const out = shape({
      steps: {
        allFolders: [FOLDER_A, FOLDER_B],
        gate: { viewer: { userId: 'u1', isAdmin: false } },
        query: [SITE_D],
      },
    })
    const byName = Object.fromEntries(out.nodes.map((n: any) => [n.name, n]))
    expect(byName['My Site'].path).toBe('Test/My Site')
  })
})

describe('GET /api/node shape step — node.path', () => {
  it('emits a nested folder path', () => {
    const shape = handlerOf(nodeRule!, 'shape')
    const out = shape({ steps: { query: FOLDER_B, allFolders: [FOLDER_A, FOLDER_B] } })
    expect(out.node.path).toBe('Test/Sub Folder')
  })

  it('emits a file path from the content url', () => {
    const shape = handlerOf(nodeRule!, 'shape')
    const out = shape({ steps: { query: FILE_C, allFolders: [FOLDER_A, FOLDER_B] } })
    expect(out.node.path).toBe('Test/Sub Folder/My File.png')
  })

  it('emits a Site path from storage_path (dir prefix), not from the entry-suffixed url', () => {
    const shape = handlerOf(nodeRule!, 'shape')
    const out = shape({ steps: { query: SITE_D, allFolders: [FOLDER_A, FOLDER_B] } })
    expect(out.node.path).toBe('Test/My Site')
  })
})
