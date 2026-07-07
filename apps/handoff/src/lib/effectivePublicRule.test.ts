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
import { readFileSync } from 'node:fs'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

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
