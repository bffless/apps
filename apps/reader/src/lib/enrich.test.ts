/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Behavioral + structural coverage of the RSS-ingest `enrich` step in the
// reader's declarative BFFless backend (apps/reader/bffless/reader.proxy-rules.json).
// The step carries a Handoff markdown post's <enclosure type="text/markdown">
// signal through to /api/items so the frontend can detect embeddable items.

// Vitest runs with cwd = the app root (apps/reader), where the vite config lives.
const rulesPath = resolve(process.cwd(), 'bffless/reader.proxy-rules.json')
const rules = JSON.parse(readFileSync(rulesPath, 'utf8')) as {
  schemas: Array<{ name: string; fields: Array<{ name: string; type: string }> }>
  rules: Array<{
    pathPattern?: string
    pipelineConfig?: { steps?: Array<{ id: string; config?: { code?: string; map?: Record<string, string> } }> }
  }>
}

function findRule(pathPattern: string) {
  const rule = rules.rules.find((r) => r.pathPattern === pathPattern)
  if (!rule) throw new Error(`rule not found: ${pathPattern}`)
  return rule
}

function findStep(pathPattern: string, stepId: string) {
  const step = findRule(pathPattern).pipelineConfig?.steps?.find((s) => s.id === stepId)
  if (!step) throw new Error(`step not found: ${pathPattern} / ${stepId}`)
  return step
}

// Materialize the sandboxed ES5 handler string into a callable function.
type Entry = {
  source?: string
  guid?: string
  title?: string
  link?: string
  author?: string
  content?: string
  summary?: string
  publishedAt?: string
  enclosures?: Array<{ url?: string; type?: string } | null> | null
}
type EnrichOut = {
  entries: Array<{
    source?: string
    guid?: string
    title?: string
    link?: string
    publishedAt?: string
    enclosureType: string | null
    enclosureUrl: string | null
  }>
}
type EnrichHandler = (arg: { steps: { parse: { entries: Entry[] }; stamp: { ms: number } } }) => EnrichOut

const enrichCode = findStep('/api/refresh', 'enrich').config?.code
if (!enrichCode) throw new Error('enrich step has no code')
const enrich = new Function('return (' + enrichCode + ')')() as EnrichHandler

function run(entries: Entry[], nowMs = 0): EnrichOut {
  return enrich({ steps: { parse: { entries }, stamp: { ms: nowMs } } })
}

describe('enrich handler — enclosure selection', () => {
  it('carries a text/markdown enclosure type + url through', () => {
    const url = 'https://handoff.j5s.dev/api/uploads/content/x.md'
    const out = run([{ guid: 'g1', enclosures: [{ url, type: 'text/markdown' }] }])
    expect(out.entries).toHaveLength(1)
    expect(out.entries[0].enclosureType).toBe('text/markdown')
    expect(out.entries[0].enclosureUrl).toBe(url)
  })

  it('sets both fields null when the entry has no enclosures', () => {
    const out = run([{ guid: 'g2' }])
    expect(out.entries[0].enclosureType).toBeNull()
    expect(out.entries[0].enclosureUrl).toBeNull()
  })

  it('sets both fields null for an empty enclosures array', () => {
    const out = run([{ guid: 'g3', enclosures: [] }])
    expect(out.entries[0].enclosureType).toBeNull()
    expect(out.entries[0].enclosureUrl).toBeNull()
  })

  it('skips a non-text enclosure and selects the first text/* one after it', () => {
    const md = 'https://handoff.j5s.dev/api/uploads/content/post.md'
    const out = run([
      {
        guid: 'g4',
        enclosures: [
          { url: 'https://cdn/img.png', type: 'image/png' },
          { url: md, type: 'text/markdown' },
        ],
      },
    ])
    expect(out.entries[0].enclosureType).toBe('text/markdown')
    expect(out.entries[0].enclosureUrl).toBe(md)
  })

  it('sets both fields null when the only enclosure is non-text', () => {
    const out = run([{ guid: 'g5', enclosures: [{ url: 'https://cdn/img.png', type: 'image/png' }] }])
    expect(out.entries[0].enclosureType).toBeNull()
    expect(out.entries[0].enclosureUrl).toBeNull()
  })

  it('tolerates a null enclosure element and one missing a type', () => {
    const md = 'https://handoff.j5s.dev/api/uploads/content/y.md'
    const out = run([
      {
        guid: 'g6',
        enclosures: [null, { url: 'https://cdn/x' }, { url: md, type: 'text/html' }],
      },
    ])
    expect(out.entries[0].enclosureType).toBe('text/html')
    expect(out.entries[0].enclosureUrl).toBe(md)
  })
})

describe('enrich handler — existing behavior preserved', () => {
  it('passes through source/guid/title/link and keeps the publishedAt fallback', () => {
    const out = run(
      [
        {
          source: 'feed-1',
          guid: 'g7',
          title: 'Hello',
          link: 'https://ex/1',
          publishedAt: '2026-01-02T03:04:05Z',
        },
        { source: 'feed-1', guid: 'g8', title: 'No date' },
      ],
      1_700_000_000_000,
    )
    expect(out.entries[0]).toMatchObject({
      source: 'feed-1',
      guid: 'g7',
      title: 'Hello',
      link: 'https://ex/1',
      publishedAt: '2026-01-02T03:04:05Z',
    })
    // Missing publishedAt falls back to the stamp's ISO time.
    expect(out.entries[1].publishedAt).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('falls back to now for an unparseable publishedAt', () => {
    const out = run([{ guid: 'g9', publishedAt: 'not-a-date' }], 1_700_000_000_000)
    expect(out.entries[0].publishedAt).toBe(new Date(1_700_000_000_000).toISOString())
  })
})

describe('proxy-rules structure — schema + upsert map', () => {
  it('reader_items schema declares enclosureType + enclosureUrl string fields', () => {
    const schema = rules.schemas.find((s) => s.name === 'reader_items')
    expect(schema).toBeTruthy()
    const names = schema!.fields.map((f) => f.name)
    expect(names).toContain('enclosureType')
    expect(names).toContain('enclosureUrl')
    for (const name of ['enclosureType', 'enclosureUrl']) {
      expect(schema!.fields.find((f) => f.name === name)?.type).toBe('string')
    }
  })

  it('the refresh upsert step maps both enclosure fields from the per-item context', () => {
    const map = findStep('/api/refresh', 'upsert').config?.map
    expect(map?.enclosureType).toBe('steps.item.enclosureType')
    expect(map?.enclosureUrl).toBe('steps.item.enclosureUrl')
  })
})
