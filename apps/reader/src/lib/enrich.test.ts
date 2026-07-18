/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// Behavioral + structural coverage of the RSS-ingest `enrich` step in the
// reader's declarative BFFless backend, authored at
// apps/reader/.bffless/proxy-rules/reader/**.
// The step carries a Handoff markdown post's <enclosure type="text/markdown">
// signal through to /api/items so the frontend can detect embeddable items.

// Vitest runs with cwd = the app root (apps/reader), where the vite config lives.
const setRoot = resolve(process.cwd(), '.bffless/proxy-rules/reader')
const refreshRule = parse(readFileSync(resolve(setRoot, 'rules/api/refresh/post/rule.yaml'), 'utf8')) as {
  pipeline?: { steps?: Array<{ id: string; handler?: string; code?: string; config?: Record<string, unknown> }> }
}
const enrichSource = readFileSync(resolve(setRoot, 'rules/api/refresh/post/enrich.fn.js'), 'utf8')
const itemsSchema = parse(readFileSync(resolve(setRoot, 'schemas/reader_items.schema.yaml'), 'utf8')) as {
  name: string
  fields: Array<{ name: string; type: string }>
}
const removeRule = parse(readFileSync(resolve(setRoot, 'rules/api/feeds/remove/post/rule.yaml'), 'utf8')) as {
  pipeline?: { steps?: Array<{ id: string; handler?: string; config?: Record<string, unknown> }> }
}

type PipelineStep = { id: string; handler?: string; code?: string; config?: Record<string, unknown> }

function findStep(rule: { pipeline?: { steps?: PipelineStep[] } }, stepId: string) {
  const step = rule.pipeline?.steps?.find((s) => s.id === stepId)
  if (!step) throw new Error(`step not found: ${stepId}`)
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

const enrich = new Function('return (' + enrichSource + ')')() as EnrichHandler

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
    expect(itemsSchema).toBeTruthy()
    const names = itemsSchema.fields.map((f) => f.name)
    expect(names).toContain('enclosureType')
    expect(names).toContain('enclosureUrl')
    for (const name of ['enclosureType', 'enclosureUrl']) {
      expect(itemsSchema.fields.find((f) => f.name === name)?.type).toBe('string')
    }
  })

  it('the refresh upsert step maps both enclosure fields from the per-item context', () => {
    const map = findStep(refreshRule, 'upsert').config?.map as Record<string, string> | undefined
    expect(map?.enclosureType).toBe('steps.item.enclosureType')
    expect(map?.enclosureUrl).toBe('steps.item.enclosureUrl')
  })

  it('the refresh upsert whitelists ONLY the two enclosure columns for update-on-existing (backfill)', () => {
    // updateFields lets a re-poll backfill enclosureType/enclosureUrl onto an
    // already-ingested row while data_upsert_many stays insert-only for every
    // other column — so read/starred and the dedup key are preserved.
    const config = findStep(refreshRule, 'upsert').config as Record<string, unknown>
    expect(config.updateFields).toEqual(['enclosureType', 'enclosureUrl'])
  })

  it('manifest wires the enrich step to enrich.fn.js', () => {
    const enrichStep = findStep(refreshRule, 'enrich')
    expect(enrichStep.code).toBe('./enrich.fn.js')
  })
})

describe('proxy-rules structure — `ne`-filtered flags must be written at ingest', () => {
  // CE compiles a `ne` filter to a bare SQL `!=` against `data->>'field'`, so a row
  // whose JSONB lacks the key yields NULL and is EXCLUDED rather than kept. Any flag
  // we filter with `ne` must therefore be stamped explicitly by the ingest map —
  // leaving it absent hides every pre-existing row. This bit us on `archived`, which
  // filtered /api/items, /api/counts and /api/prune while nothing ever wrote it.
  const ruleFiles = readdirSync(resolve(setRoot, 'rules'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('rule.yaml') || f.endsWith('.rule.yaml'))
    .map((f) => resolve(setRoot, 'rules', f))

  const upsertMap = findStep(refreshRule, 'upsert').config?.map as Record<string, string>

  // Fields the reader filters with `ne` against the reader_items table, collected
  // from every authored rule rather than hard-coded, so a new one is covered on sight.
  const neFiltered = new Set<string>()
  for (const file of ruleFiles) {
    const rule = parse(readFileSync(file, 'utf8')) as { pipeline?: { steps?: PipelineStep[] } }
    for (const step of rule.pipeline?.steps ?? []) {
      const config = step.config as Record<string, unknown> | undefined
      if (config?.schemaId !== '$schema:reader_items') continue
      const filters = config.filters as Record<string, { op?: string }> | undefined
      for (const [field, filter] of Object.entries(filters ?? {})) {
        if (filter?.op === 'ne') neFiltered.add(field)
      }
    }
  }

  it('collects the `ne`-filtered item flags from the authored rules', () => {
    // Guards the scan itself — an empty set would make the assertion below vacuous.
    expect(neFiltered).toContain('archived')
    expect(neFiltered).toContain('starred')
  })

  it('ingest stamps every `ne`-filtered flag, so no row is missing the key', () => {
    for (const field of neFiltered) {
      expect(upsertMap?.[field], `${field} is \`ne\`-filtered but never written by the refresh upsert map`).toBeDefined()
    }
  })

  it('stamps archived=false on ingest', () => {
    // Unquoted in YAML: the evaluator passes a real boolean straight through, and a
    // filter stringifies it, so both positions behave exactly as the old "false" did.
    expect(upsertMap?.archived).toBe(false)
  })
})

describe('proxy-rules structure — unsubscribe cascade', () => {
  it('removing a feed cascade-deletes its non-starred items (starred spared)', () => {
    const del = findStep(removeRule, 'delItems')
    expect(del.handler).toBe('data_delete')
    const config = del.config as Record<string, unknown>
    // Targets reader_items, not reader_feeds.
    expect(config.schemaId).toBe('$schema:reader_items')
    // Only runs once the feed row was found + removed.
    expect(config.condition).toBe('steps.pick.found')
    // Delete-by-query: the feed's items (feedId == the posted url) AND not starred.
    const filters = config.filters as Record<string, { op: string; value: string }>
    expect(filters.feedId).toEqual({ op: 'eq', value: 'request.body.url' })
    expect(filters.starred).toEqual({ op: 'ne', value: true })
    expect(config.filterLogic).toBe('and')
  })
})
