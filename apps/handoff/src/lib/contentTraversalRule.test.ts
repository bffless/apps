// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Traversal guard for GET /api/uploads/content/* (issue #238).
 *
 * `parsePath` turns the request path into two things the rest of the pipeline trusts:
 * `fullKey`, which the gate authorizes, and `rest`, which the `serve` step interpolates
 * straight into a storage key (`content/{{steps.parsePath.rest}}`). It used to decode each
 * `%xx` segment without ever rejecting a `.` or `..`, while its sibling `/api/resolve/*`
 * parser did reject them.
 *
 * That asymmetry was not cosmetic. The gate authorizes a Site-internal asset by *string
 * prefix* — the deepest Site whose `storage_path` prefixes `fullKey` — so a key that walks
 * out of a readable Site with `..` still carries that Site's prefix, and inherits its access.
 * Authorization is decided on the un-normalized key; the object is then fetched with that
 * same un-normalized key. Any storage layer that normalizes `..` (a filesystem adapter's
 * path.join does; S3-style literal keys do not) reads a different object than the one the
 * gate said yes to. The guard closes that at the parser, so the property does not depend on
 * which storage backend is configured.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, findRule, handlerOf } from '../test/proxyRules'

const proxy = await loadProxyRules()

const serve = findRule(proxy.rules, '/api/uploads/content/*')
const resolve = findRule(proxy.rules, '/api/resolve/*')

const parsePath = handlerOf(serve, 'parsePath')
const resolveParse = handlerOf(resolve, 'parse')
const gate = handlerOf(serve, 'gate')

const deployment = { owner: 'bffless', repo: 'apps' }

/** Run the serve rule's parser over a raw request path, as CE would. */
const parse = (path: string) => parsePath({ request: { path }, deployment })

/** A Site anyone can read — the prefix an attacker would borrow to escape. */
const PUBLIC_SITE = {
  id: '00000000-0000-4000-8000-0000000000a1',
  nodeType: 'site',
  parentId: 'root',
  ownerId: 'alice',
  storage_path: 'bffless/apps/uploads/content/proto',
}

describe('parsePath refuses traversal segments', () => {
  it('rejects a bare `..` segment', () => {
    const out = parse('/api/uploads/content/proto/../secret.pdf')
    expect(out.bad).toBe(true)
    expect(out.hasKey).toBe(false)
  })

  it('rejects a `..` that only appears after percent-decoding', () => {
    // The decode happens before the check, so `%2e%2e` must not smuggle one past it.
    const out = parse('/api/uploads/content/proto/%2e%2e/secret.pdf')
    expect(out.bad).toBe(true)
    expect(out.hasKey).toBe(false)
  })

  it('rejects a single-dot segment', () => {
    expect(parse('/api/uploads/content/proto/./index.html').bad).toBe(true)
  })

  it('emits no usable key or storage path for a refused request', () => {
    // Both outputs must be inert: `fullKey` is what the gate matches a Site prefix against,
    // and `rest` is interpolated into the serve step's storage key. Neither may carry the `..`.
    const out = parse('/api/uploads/content/proto/../../secret.pdf')
    expect(out.fullKey).toBe('')
    expect(out.rest).toBe('')
    expect(out.rest).not.toContain('..')
  })

  it('still accepts ordinary paths, including dots inside a filename', () => {
    const out = parse('/api/uploads/content/proto/docs/my.file.v2.png')
    expect(out.bad).toBe(false)
    expect(out.hasKey).toBe(true)
    expect(out.rest).toBe('proto/docs/my.file.v2.png')
    expect(out.fullKey).toBe('bffless/apps/uploads/content/proto/docs/my.file.v2.png')
  })

  it('still decodes percent-encoded spaces in real names', () => {
    const out = parse('/api/uploads/content/Test/Sub%20Folder/My%20File.png')
    expect(out.bad).toBe(false)
    expect(out.rest).toBe('Test/Sub Folder/My File.png')
  })

  it('matches the sibling /api/resolve parser, which already refused traversal', () => {
    // The asymmetry between these two is what #238 is about. Lock them together so neither
    // side can regress alone.
    const out = resolveParse({ request: { path: '/api/resolve/proto/../secret.pdf' }, deployment })
    expect(out.hasPath).toBe(false)
    expect(out.fullKey).toBe('')
  })
})

describe('a traversal key cannot borrow a readable Site prefix', () => {
  it('no longer inherits the Site access it walks out of', () => {
    // The bypass shape: `alice` owns the Site rooted at `proto/`. `proto/../<other>` still
    // begins with the Site's storage_path, so the gate's prefix match would hand alice that
    // Site's OWNER access — while the served key points at an object outside the Site. Viewing
    // as the owner makes the escape observable: pre-guard this returned `allow: true`.
    const path = '/api/uploads/content/proto/../private/secret.pdf'
    const out = parse(path)

    const decision = gate({
      user: { id: 'alice' },
      request: { headers: {} },
      utils: { verify: () => false, base64urlDecode: (v: string) => v },
      steps: { allFolders: [], allSites: [PUBLIC_SITE], parsePath: out, nodeByKey: [] },
    })

    expect(decision.allow).toBe(false)
    expect(decision.deny400).toBe(true)
    // The refusal is a 400, not a 404 — exactly one response step may fire (see below).
    expect(decision.deny404).toBe(false)
  })

  it('leaves a legitimate Site asset reachable', () => {
    // The guard must not cost the Site-prefix authorization its actual job.
    const out = parse('/api/uploads/content/proto/assets/app.js')
    const decision = gate({
      user: { id: 'alice' },
      request: { headers: {} },
      utils: { verify: () => false, base64urlDecode: (v: string) => v },
      steps: { allFolders: [], allSites: [PUBLIC_SITE], parsePath: out, nodeByKey: [] },
    })
    expect(decision).toMatchObject({ allow: true, deny400: false, resolved: true })
  })
})

describe('the serve rule answers a refused path with a 400', () => {
  it('carries a deny400 response step gated on the parser verdict', () => {
    const deny400 = serve.pipelineConfig.steps.find((s: any) => s.id === 'deny400')
    expect(deny400).toBeTruthy()
    expect(deny400.handlerType).toBe('response_handler')
    expect(deny400.config.status).toBe(400)
    expect(deny400.config.condition).toBe('steps.gate.deny400')
  })

  it('keeps the deny conditions mutually exclusive', () => {
    // CE's executor does NOT stop at the first response_handler whose condition holds: it keeps
    // the last step that actually ran and builds the response from that
    // (pipeline-execution.service.ts — "preserve the previous step's output so the response comes
    // from the last step that actually ran"). So two deny steps firing at once would silently
    // resolve to whichever is ordered last, not the more specific one. Exactly one must be true.
    const out = parse('/api/uploads/content/proto/../private/secret.pdf')
    const decision = gate({
      user: null,
      request: { headers: {} },
      utils: { verify: () => false, base64urlDecode: (v: string) => v },
      steps: { allFolders: [], allSites: [PUBLIC_SITE], parsePath: out, nodeByKey: [] },
    })

    const fired = ['deny400', 'deny401', 'deny403', 'deny404'].filter(
      (k) => (decision as Record<string, unknown>)[k] === true,
    )
    expect(fired).toEqual(['deny400'])
    expect(decision.allow).toBe(false)
  })
})
