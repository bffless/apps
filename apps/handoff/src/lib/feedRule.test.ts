// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural + behavioral guard for the public folder RSS feed rules
 * (Handoff RSS spine #188): /feed/<path>.xml and the root /feed.xml. Runs the
 * real embedded parse/select handlers (the same JS CE executes) against mock
 * node rows — the pipeline is the only place feed selection runs live, so this
 * pins the flatten + Anyone-gate + RSS render behaviour.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'

const NODES_SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'

const proxy = await loadProxyRules()

const feedRule = proxy.rules.find((r) => r.pathPattern === '/feed/*')
const rootRule = proxy.rules.find((r) => r.pathPattern === '/feed.xml')

function handlerOf(rule: any, stepId: string): (ctx: any) => any {
  const step = rule.pipelineConfig.steps.find((s: any) => s.id === stepId)
  return compileHandler(step.config.code) as (ctx: any) => any
}

// --- Mock node rows (raw data-table shape the handlers read) --------------
const ROOT = { id: '00000000-0000-4000-8000-000000000000', nodeType: 'root', displayName: 'My Files', parentId: '', grantsJson: '[]', mode: 'inheriting' }
const PUB = { id: 'aaaaaaaa-0000-4000-8000-000000000001', nodeType: 'folder', displayName: 'Public', parentId: 'root', ownerId: 'owner-1', mode: 'inheriting', grantsJson: JSON.stringify([{ principalId: 'anyone', level: 'view' }]) }
const PRIV = { id: 'bbbbbbbb-0000-4000-8000-000000000002', nodeType: 'folder', displayName: 'Private', parentId: 'root', ownerId: 'owner-1', mode: 'inheriting', grantsJson: '[]' }
const SECRET = { id: 'cccccccc-0000-4000-8000-000000000003', nodeType: 'folder', displayName: 'Secret', parentId: PUB.id, ownerId: 'owner-1', mode: 'restricted', grantsJson: '[]' }
const F1 = { id: 'dddddddd-0000-4000-8000-000000000004', nodeType: 'file', displayName: 'a.png', parentId: PUB.id, content_type: 'image/png', size: 100, createdMs: 100 }
const F2 = { id: 'eeeeeeee-0000-4000-8000-000000000005', nodeType: 'file', displayName: 'b & c.txt', parentId: PUB.id, content_type: 'text/plain', size: 200, createdMs: 300 }
const SITE1 = { id: 'ffffffff-0000-4000-8000-000000000006', nodeType: 'site', displayName: 'Portfolio', parentId: PUB.id, createdMs: 200 }
const HIDDEN = { id: '11111111-0000-4000-8000-000000000007', nodeType: 'file', displayName: 'hidden.txt', parentId: SECRET.id, content_type: 'text/plain', size: 9, createdMs: 400 }
const FT = { id: '22222222-0000-4000-8000-00000000000a', nodeType: 'file', displayName: 'deck.png', parentId: PUB.id, content_type: 'image/png', size: 50, createdMs: 500, title: 'Board Deck', description: 'see slide 4 & 5' }
const ST = { id: '33333333-0000-4000-8000-00000000000b', nodeType: 'site', displayName: 'Portfolio2', parentId: PUB.id, createdMs: 600, description: 'my work' }

const ALL = [ROOT, PUB, PRIV, SECRET, F1, F2, SITE1, HIDDEN]

function runSelect(
  segments: string[],
  opts?: { isRoot?: boolean; bad?: boolean; nodes?: any[]; token?: string; link?: any },
) {
  const select = handlerOf(feedRule, 'select')
  // Model reality: file/site leaves carry a storage_path (the verbatim upload
  // key), and the feed derives the content path by stripping its uploads-content
  // prefix — NOT from displayName. Auto-derive storage_path from the displayName
  // chain for any leaf that doesn't set one (mirrors UI uploads, where the stored
  // segment == displayName) so the existing assertions hold; a test that needs
  // displayName != stored path sets storage_path explicitly.
  const raw = (opts?.nodes ?? ALL).map((n) => ({ ...n }))
  const byIdRaw = new Map(raw.map((n) => [n.id, n]))
  for (const n of raw) {
    if ((n.nodeType === 'file' || n.nodeType === 'site') && !n.storage_path) {
      const segs: string[] = []
      let cur: any = n
      let g = 0
      while (cur && cur.nodeType !== 'root' && g < 64) {
        segs.unshift(cur.displayName)
        cur = byIdRaw.get(cur.parentId)
        g++
      }
      n.storage_path = `bffless/apps/uploads/content/${segs.join('/')}`
    }
  }
  // data_query rows are FROZEN in the CE sandbox — freeze here too so a handler
  // that mutates a row (e.g. stamping an id) fails in the test, not just live.
  const nodes = raw.map((n) => Object.freeze({ ...n }))
  const token = opts?.token ?? ''
  return select({
    request: { headers: { host: 'handoff.j5s.dev' } },
    steps: {
      parse: {
        path: segments.join('/'),
        segments,
        isRoot: opts?.isRoot ?? segments.length === 0,
        bad: opts?.bad ?? false,
        token,
        hasToken: token !== '',
      },
      allNodes: Object.freeze(nodes),
      // The link data_query returns a single record (or undefined when the
      // condition/token is absent) — freeze it like a live row.
      link: opts?.link ? Object.freeze({ ...opts.link }) : undefined,
    },
  })
}

// A live-ish Share Link record (raw data-table shape the check reads), scoped to
// the private folder and not revoked/expired.
const TOKEN = '99999999-0000-4000-8000-0000000000aa'
function shareLink(folderId: string, over?: Record<string, unknown>) {
  return { token: TOKEN, folderId, revoked: false, expiresMs: null, ...over }
}

describe('/feed/* + /feed.xml — structure', () => {
  it('both rules are enabled GET+HEAD pipeline rules', () => {
    for (const r of [feedRule, rootRule]) {
      expect(r).toBeTruthy()
      expect(r!.proxyType).toBe('pipeline')
      expect(r!.isEnabled).toBe(true)
      expect(r!.methods).toEqual(['GET', 'HEAD'])
      expect(r!.preserveHost).toBe(false)
      expect(r!.forwardCookies).toBe(false)
    }
  })

  it('orders after PATCH /api/node (31); wildcard is disjoint from other rules', () => {
    expect(feedRule!.order).toBeGreaterThan(31)
    expect(rootRule!.order).toBeGreaterThan(31)
  })

  it('queries all nodes against the nodes schema and emits application/rss+xml', () => {
    const q = feedRule!.pipelineConfig.steps.find((s: any) => s.id === 'allNodes')
    expect(q.handlerType).toBe('data_query')
    expect(q.config.schemaId).toBe(NODES_SCHEMA)
    const ok = feedRule!.pipelineConfig.steps.find((s: any) => s.id === 'ok')
    expect(ok.config.status).toBe(200)
    expect(ok.config.contentType).toBe('application/rss+xml')
    expect(ok.config.condition).toBe('steps.select.found')
    expect(ok.config.body).toBe('{{{steps.select.xml}}}')
    const nf = feedRule!.pipelineConfig.steps.find((s: any) => s.id === 'notfound')
    expect(nf.config.status).toBe(404)
    expect(nf.config.condition).toBe('steps.select.notfound')
  })

  it('the root rule shares the same pipeline steps', () => {
    expect(rootRule!.pipelineConfig.steps.map((s: any) => s.id)).toEqual(
      feedRule!.pipelineConfig.steps.map((s: any) => s.id),
    )
  })
})

describe('parse step', () => {
  const parse = () => handlerOf(feedRule, 'parse')

  it('decodes /feed/<path>.xml per segment and strips the .xml extension', () => {
    const out = parse()({ request: { path: '/feed/Public/Sub%20Folder.xml' } })
    expect(out.segments).toEqual(['Public', 'Sub Folder'])
    expect(out.path).toBe('Public/Sub Folder')
    expect(out.isRoot).toBe(false)
    expect(out.bad).toBe(false)
  })

  it('treats /feed.xml as the root feed', () => {
    const out = parse()({ request: { path: '/feed.xml' } })
    expect(out.segments).toEqual([])
    expect(out.isRoot).toBe(true)
  })

  it('rejects dot segments', () => {
    const out = parse()({ request: { path: '/feed/Public/../secret.xml' } })
    expect(out.bad).toBe(true)
  })

  it('surfaces a well-formed ?token= as hasToken (#189)', () => {
    const out = parse()({ request: { path: '/feed/Private.xml', query: { token: TOKEN } } })
    expect(out.token).toBe(TOKEN)
    expect(out.hasToken).toBe(true)
  })

  it('does not treat a malformed token as usable', () => {
    const out = parse()({ request: { path: '/feed/Private.xml', query: { token: 'not-a-uuid' } } })
    expect(out.token).toBe('not-a-uuid')
    expect(out.hasToken).toBe(false)
    // No query → empty token.
    expect(parse()({ request: { path: '/feed/Private.xml' } }).hasToken).toBe(false)
  })
})

describe('select step — flatten + Anyone gate + render', () => {
  it('renders a public folder feed: subtree leaves flattened, newest-first', () => {
    const out = runSelect(['Public'])
    expect(out.found).toBe(true)
    const xml: string = out.xml
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain(`<guid isPermaLink="false">${F1.id}</guid>`)
    expect(xml).toContain(`<guid isPermaLink="false">${F2.id}</guid>`)
    expect(xml).toContain(`<guid isPermaLink="false">${SITE1.id}</guid>`)
    // Newest-first: F2 (300) before SITE1 (200) before F1 (100).
    expect(xml.indexOf(F2.id)).toBeLessThan(xml.indexOf(SITE1.id))
    expect(xml.indexOf(SITE1.id)).toBeLessThan(xml.indexOf(F1.id))
  })

  it('excludes a Restricted-private descendant (no leak)', () => {
    const xml: string = runSelect(['Public']).xml
    expect(xml).not.toContain(HIDDEN.id)
    expect(xml).not.toContain('hidden.txt')
  })

  it('drops a feedExcluded folder subtree from an ancestor feed, keeping siblings (#191)', () => {
    // assets/ under the public folder is feed-excluded — its image must not
    // surface, even nested — while PUB's own files stay.
    const ASSETS = { id: 'a5555555-0000-4000-8000-0000000000e1', nodeType: 'folder', displayName: 'assets', parentId: PUB.id, ownerId: 'owner-1', mode: 'inheriting', grantsJson: '[]', feedExcluded: true }
    const IMG = { id: 'a5555555-0000-4000-8000-0000000000e2', nodeType: 'file', displayName: 'pic.png', parentId: ASSETS.id, content_type: 'image/png', size: 5, createdMs: 500 }
    const DEEP = { id: 'a5555555-0000-4000-8000-0000000000e3', nodeType: 'folder', displayName: 'deep', parentId: ASSETS.id, ownerId: 'owner-1', mode: 'inheriting', grantsJson: '[]' }
    const NESTED = { id: 'a5555555-0000-4000-8000-0000000000e4', nodeType: 'file', displayName: 'nested.png', parentId: DEEP.id, content_type: 'image/png', size: 6, createdMs: 600 }
    const xml: string = runSelect(['Public'], { nodes: [ROOT, PUB, F1, ASSETS, IMG, DEEP, NESTED] }).xml
    // PUB's own leaf stays; the excluded subtree (direct + nested) is gone.
    expect(xml).toContain(`<guid isPermaLink="false">${F1.id}</guid>`)
    expect(xml).not.toContain(IMG.id)
    expect(xml).not.toContain(NESTED.id)
  })

  it('unmarking feedExcluded restores the subtree (#191)', () => {
    const ASSETS = { id: 'a5555555-0000-4000-8000-0000000000f5', nodeType: 'folder', displayName: 'assets', parentId: PUB.id, ownerId: 'owner-1', mode: 'inheriting', grantsJson: '[]', feedExcluded: false }
    const IMG = { id: 'a5555555-0000-4000-8000-0000000000f6', nodeType: 'file', displayName: 'pic.png', parentId: ASSETS.id, content_type: 'image/png', size: 5, createdMs: 500 }
    const xml: string = runSelect(['Public'], { nodes: [ROOT, PUB, ASSETS, IMG] }).xml
    expect(xml).toContain(`<guid isPermaLink="false">${IMG.id}</guid>`)
  })

  it('an excluded folder’s OWN feed surfaces nothing but stays browsable (#191)', () => {
    const ASSETS = { id: 'a5555555-0000-4000-8000-0000000000a7', nodeType: 'folder', displayName: 'assets', parentId: PUB.id, ownerId: 'owner-1', mode: 'inheriting', grantsJson: JSON.stringify([{ principalId: 'anyone', level: 'view' }]), feedExcluded: true }
    const IMG = { id: 'a5555555-0000-4000-8000-0000000000a8', nodeType: 'file', displayName: 'pic.png', parentId: ASSETS.id, content_type: 'image/png', size: 5, createdMs: 500 }
    const out = runSelect(['Public', 'assets'], { nodes: [ROOT, PUB, ASSETS, IMG] })
    // Resolves + is public (found), but its excluded subtree yields no items.
    expect(out.found).toBe(true)
    expect(out.xml).not.toContain(IMG.id)
    expect(out.xml).not.toContain('<item>')
  })

  it('gives File items a mime/length enclosure and Site items a text/html enclosure; XML-escapes names', () => {
    const xml: string = runSelect(['Public']).xml
    // Public feed: media URL is the tokenless byte-serving content endpoint.
    expect(xml).toContain(`<enclosure url="https://handoff.j5s.dev/api/uploads/content/Public/b%20%26%20c.txt" type="text/plain" length="200"/>`)
    expect(xml).toContain('<title>b &amp; c.txt</title>')
    // Site gets its viewer link + a text/html enclosure (the reader's embed signal).
    expect(xml).toContain(`<link>https://handoff.j5s.dev/blob/Public/Portfolio</link>`)
    expect(xml).toContain(`<enclosure url="https://handoff.j5s.dev/blob/Public/Portfolio" type="text/html" length="0"/>`)
  })

  it('builds link + enclosure from storage_path, NOT displayName (title ≠ filename)', () => {
    // A file whose human title (displayName) differs from its stored filename —
    // e.g. uploaded via the API with a pretty title. The link + media URL MUST use
    // the storage_path-derived path (what /api/resolve + the content serve key on)
    // or they 404 in a reader; displayName is only the human <title>.
    const MD = {
      id: 'abcd0000-0000-4000-8000-0000000000cd',
      nodeType: 'file',
      displayName: 'Feed Content Bodies — CE Pipeline (design spec)',
      parentId: PUB.id,
      content_type: 'text/markdown',
      size: 16082,
      createdMs: 999,
      storage_path: 'bffless/apps/uploads/content/Public/2026-07-08-design.md',
    }
    const xml: string = runSelect(['Public'], { nodes: [ROOT, PUB, MD] }).xml
    // link + enclosure use the STORED path...
    expect(xml).toContain('<link>https://handoff.j5s.dev/blob/Public/2026-07-08-design.md</link>')
    expect(xml).toContain('<enclosure url="https://handoff.j5s.dev/api/uploads/content/Public/2026-07-08-design.md" type="text/markdown" length="16082"/>')
    // ...while the human <title> still shows the displayName.
    expect(xml).toContain('<title>Feed Content Bodies — CE Pipeline (design spec)</title>')
    // The displayName must never leak into a URL.
    expect(xml).not.toContain('/blob/Public/Feed%20Content')
  })

  it('404s a private (non-public) folder — tokenless feeds are public-only', () => {
    const out = runSelect(['Private'])
    expect(out.found).toBe(false)
    expect(out.notfound).toBe(true)
  })

  it('serves a private folder feed with a valid Share Link token (#189)', () => {
    // A file under the private folder so the feed has a leaf to render.
    const pf = { id: 'aaaa0000-0000-4000-8000-0000000000f1', nodeType: 'file', displayName: 'p.txt', parentId: PRIV.id, content_type: 'text/plain', size: 7, createdMs: 50 }
    const out = runSelect(['Private'], { nodes: [ROOT, PRIV, pf], token: TOKEN, link: shareLink(PRIV.id) })
    expect(out.found).toBe(true)
    const xml: string = out.xml
    expect(xml).toContain(`<guid isPermaLink="false">${pf.id}</guid>`)
    // Every item link + enclosure + the self href carries the token.
    expect(xml).toContain(`<link>https://handoff.j5s.dev/blob/Private/p.txt?token=${TOKEN}</link>`)
    expect(xml).toContain(`<enclosure url="https://handoff.j5s.dev/r/${pf.id}/p.txt?token=${TOKEN}" type="text/plain" length="7"/>`)
    expect(xml).toContain(`href="https://handoff.j5s.dev/feed/Private.xml?token=${TOKEN}"`)
  })

  it('denies a private folder feed when the token is revoked or expired (no leak)', () => {
    const pf = { id: 'aaaa0000-0000-4000-8000-0000000000f2', nodeType: 'file', displayName: 'p.txt', parentId: PRIV.id, content_type: 'text/plain', size: 7, createdMs: 50 }
    const revoked = runSelect(['Private'], { nodes: [ROOT, PRIV, pf], token: TOKEN, link: shareLink(PRIV.id, { revoked: true }) })
    expect(revoked.notfound).toBe(true)
    const expired = runSelect(['Private'], { nodes: [ROOT, PRIV, pf], token: TOKEN, link: shareLink(PRIV.id, { expiresMs: 1 }) })
    expect(expired.notfound).toBe(true)
    // Token scoped to a DIFFERENT folder must not unlock this one.
    const wrong = runSelect(['Private'], { nodes: [ROOT, PRIV, pf], token: TOKEN, link: shareLink(PUB.id) })
    expect(wrong.notfound).toBe(true)
  })

  it('keeps a public folder feed tokenless even when a token is supplied', () => {
    // Public feed accessed with a token still renders public, tokenless URLs
    // unless the token validates for it — here no link record, so no token.
    const xml: string = runSelect(['Public'], { token: TOKEN }).xml
    expect(xml).not.toContain('?token=')
  })

  it('404s an unresolvable path', () => {
    const out = runSelect(['Nope'])
    expect(out.notfound).toBe(true)
  })

  it('serves a valid empty channel for a public-but-empty folder', () => {
    const out = runSelect(['Public'], { nodes: [ROOT, PUB].map((n) => ({ ...n })) })
    expect(out.found).toBe(true)
    expect(out.xml).toContain('<channel>')
    expect(out.xml).not.toContain('<item>')
  })

  it('normalizes mixed top-level parent refs (root sentinel vs root id)', () => {
    // Live data references the root inconsistently: a file uses the 'root'
    // sentinel while a folder uses the root record's id. Both must resolve —
    // the folder feed AND the root feed must include the folder's subtree.
    const publicRoot = { ...ROOT, grantsJson: JSON.stringify([{ principalId: 'anyone', level: 'view' }]) }
    const rootFile = { id: '33333333-0000-4000-8000-000000000009', nodeType: 'file', displayName: 'top.txt', parentId: 'root', content_type: 'text/plain', size: 5, createdMs: 10 }
    // 'one' references the root by its ID, not the 'root' sentinel.
    const one = { id: '44444444-0000-4000-8000-00000000000a', nodeType: 'folder', displayName: 'one', parentId: ROOT.id, mode: 'inheriting', grantsJson: '[]' }
    const deep = { id: '55555555-0000-4000-8000-00000000000b', nodeType: 'file', displayName: 'deep.txt', parentId: one.id, content_type: 'text/plain', size: 9, createdMs: 20 }
    const nodes = [publicRoot, rootFile, one, deep]

    // Folder feed for 'one' resolves via id-referenced parent walk.
    const oneFeed = runSelect(['one'], { nodes })
    expect(oneFeed.found).toBe(true)
    expect(oneFeed.xml).toContain(`<guid isPermaLink="false">${deep.id}</guid>`)
    // Path excludes the root record's name.
    expect(oneFeed.xml).toContain('<link>https://handoff.j5s.dev/blob/one/deep.txt</link>')

    // Root feed flattens BOTH the sentinel-parented file and the id-parented subtree.
    const rootFeed = runSelect([], { isRoot: true, nodes })
    expect(rootFeed.xml).toContain(`<guid isPermaLink="false">${rootFile.id}</guid>`)
    expect(rootFeed.xml).toContain(`<guid isPermaLink="false">${deep.id}</guid>`)
  })

  it('root feed (/feed.xml) surfaces top-level public leaves when root is public', () => {
    const publicRoot = { ...ROOT, grantsJson: JSON.stringify([{ principalId: 'anyone', level: 'view' }]) }
    const topFile = { id: '22222222-0000-4000-8000-000000000008', nodeType: 'file', displayName: 'top.txt', parentId: 'root', content_type: 'text/plain', size: 5, createdMs: 500 }
    const out = runSelect([], { isRoot: true, nodes: [publicRoot, topFile].map((n) => ({ ...n })) })
    expect(out.found).toBe(true)
    expect(out.xml).toContain('<title>My Files</title>')
    expect(out.xml).toContain(`<guid isPermaLink="false">${topFile.id}</guid>`)
    expect(out.xml).toContain('href="https://handoff.j5s.dev/feed.xml"')
  })

  it('renders item title override + description note (pipeline == reference)', () => {
    // Root must itself carry an Anyone grant to be publicly resolvable (see
    // the "surfaces top-level public leaves" test above) — PUB's own grant
    // only covers PUB's subtree, not the root feed.
    const publicRoot = { ...ROOT, grantsJson: JSON.stringify([{ principalId: 'anyone', level: 'view' }]) }
    const res = runSelect([], { isRoot: true, nodes: [publicRoot, PUB, FT, ST].map((n) => ({ ...n })) })
    expect(res.found).toBe(true)
    expect(res.xml).toContain('<title>Board Deck</title>')
    expect(res.xml).toContain('<description><![CDATA[<p>see slide 4 &amp; 5</p><p><img')
    expect(res.xml).toContain('<description><![CDATA[<p>my work</p>]]></description>')
  })
})
