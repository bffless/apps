// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Seam C — structural guard for the verbatim structural-storage rules
 * (structural storage, Slice 1 / issue #156). The embedded pipeline logic runs
 * only in CE's runner (validated live via MCP); this asserts the exported rule
 * set is wired the way the design requires:
 *
 *  - POST /api/uploads/prepare declares verbatim key mode with a `key`
 *    expression, so the stored object key is the app-controlled content
 *    sub-path (folder path + name) — no UUID prefix, no slash-flattening.
 *  - POST /api/nodes registers that same verbatim key.
 *  - GET /api/uploads/content/* is pure path passthrough: it resolves the node
 *    by storage_path and serves the object by its exact key through the file
 *    server (no manifest map, no presigned bucket URL).
 *
 * See docs/superpowers/specs/2026-07-05-structural-content-storage-design.md.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const NODES_SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'

const proxy = JSON.parse(
  readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, any>> }

const prepare = proxy.rules.find(
  (r) => r.pathPattern === '/api/uploads/prepare' && r.method === 'POST',
)
const register = proxy.rules.find((r) => r.pathPattern === '/api/nodes' && r.method === 'POST')
const serve = proxy.rules.find((r) => r.pathPattern === '/api/uploads/content/*')

describe('verbatim prepare rule (POST /api/uploads/prepare)', () => {
  it('exists as an enabled pipeline rule', () => {
    expect(prepare).toBeTruthy()
    expect(prepare!.proxyType).toBe('pipeline')
    expect(prepare!.isEnabled).toBe(true)
  })

  it('declares verbatim key mode with a key expression on the presigned step', () => {
    const step = prepare!.pipelineConfig.steps.find((s: any) => s.id === 'presigned')
    expect(step.handlerType).toBe('presigned_upload')
    expect(step.config.keyStrategy).toBe('verbatim')
    // The key is the app-supplied content sub-path (folder path + name).
    expect(step.config.key).toBe('request.body.path')
    expect(step.config.subDir).toBe('content')
  })
})

describe('verbatim register rule (POST /api/nodes)', () => {
  it('registers the same verbatim key against the nodes schema', () => {
    const step = register!.pipelineConfig.steps.find((s: any) => s.id === 'register')
    expect(step.handlerType).toBe('register_upload')
    expect(step.config.keyStrategy).toBe('verbatim')
    expect(step.config.key).toBe('request.body.path')
    expect(step.config.schemaId).toBe(NODES_SCHEMA)
  })
})

describe('unified content serve rule (GET /api/uploads/content/*) — path passthrough', () => {
  it('resolves the node by its storage_path (the verbatim key), not a manifest', () => {
    const node = serve!.pipelineConfig.steps.find((s: any) => s.id === 'nodeByKey')
    expect(node.handlerType).toBe('data_query')
    expect(node.config.schemaId).toBe(NODES_SCHEMA)
    expect(node.config.filters.storage_path.value).toBe('steps.parsePath.fullKey')
  })

  it('serves the object by its exact key through the file server — never a presigned URL', () => {
    const types = serve!.pipelineConfig.steps.map((s: any) => s.handlerType)
    expect(types).toContain('file_serve_handler')
    expect(types).not.toContain('signed_url')
    const fileServe = serve!.pipelineConfig.steps.find((s: any) => s.id === 'serve')
    // Explicit key mode: serve the exact decoded key from parsePath. subDir
    // mode would re-derive the key from the percent-encoded request URL and
    // miss any object whose name needed encoding (spaces, unicode).
    expect(fileServe.config.key).toBe('content/{{steps.parsePath.rest}}')
    expect(fileServe.config.subDir).toBeUndefined()
    expect(fileServe.config.condition).toBe('steps.gate.allow')
  })

  it('parses the content sub-path straight from the request URL (no rewriting)', () => {
    const parse = serve!.pipelineConfig.steps.find((s: any) => s.id === 'parsePath')
    expect(parse.handlerType).toBe('function_handler')
    expect(parse.config.code).toContain('/api/uploads/content/')
  })

  it('URL-decodes each request-path segment so names with spaces/unicode resolve', () => {
    // The browser percent-encodes the path; storage_path holds the decoded
    // verbatim key. Run the real embedded handler to pin the decode.
    const parse = serve!.pipelineConfig.steps.find((s: any) => s.id === 'parsePath')
    const handler = new Function(`return (${parse.config.code})`)() as (ctx: any) => {
      rest: string
      fullKey: string
      hasKey: boolean
    }
    const out = handler({
      request: {
        path: '/api/uploads/content/Test/Screenshot%202026-07-06%20at%206.47.11%E2%80%AFAM.png',
      },
      deployment: { owner: 'bffless', repo: 'apps' },
    })
    expect(out.fullKey).toBe(
      // %E2%80%AF is U+202F (narrow no-break space, macOS screenshot names).
      'bffless/apps/uploads/content/Test/Screenshot 2026-07-06 at 6.47.11\u202FAM.png',
    )
    // A malformed escape must not throw — the raw segment is kept.
    const bad = handler({
      request: { path: '/api/uploads/content/Test/100%.png' },
      deployment: { owner: 'o', repo: 'r' },
    })
    expect(bad.fullKey).toBe('o/r/uploads/content/Test/100%.png')
  })
})
