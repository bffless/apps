/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const setRoot = resolve(process.cwd(), '.bffless/proxy-rules/reader')
const urlsSource = readFileSync(resolve(setRoot, 'rules/api/refresh/post/urls.fn.js'), 'utf8')
const enrichSource = readFileSync(resolve(setRoot, 'rules/api/refresh/post/enrich.fn.js'), 'utf8')
const refreshRule = parse(
  readFileSync(resolve(setRoot, 'rules/api/refresh/post/rule.yaml'), 'utf8'),
) as { pipeline?: { steps?: Array<{ id: string; config?: Record<string, unknown> }> } }

type Feed = { url?: string; userId?: string }
type Entry = { source?: string; guid?: string; link?: string; title?: string; publishedAt?: string }
type Enriched = { userId: string; scopedGuid: string; guid?: string; itemGuid?: string; source?: string }

const urls = new Function('return (' + urlsSource + ')')() as (a: {
  steps: { feeds: Feed[] }
}) => { urls: string[]; count: number }

const enrich = new Function('return (' + enrichSource + ')')() as (a: {
  steps: { feeds: Feed[]; parse: { entries: Entry[] }; stamp: { ms: number } }
}) => { entries: Enriched[] }

function fanout(feeds: Feed[], entries: Entry[]) {
  return enrich({ steps: { feeds, parse: { entries }, stamp: { ms: 0 } } }).entries
}

describe('urls handler — dedupe', () => {
  it('fetches a shared feed once no matter how many subscribers', () => {
    const out = urls({
      steps: {
        feeds: [
          { url: 'https://a.com/f.xml', userId: 'u1' },
          { url: 'https://a.com/f.xml', userId: 'u2' },
          { url: 'https://b.com/f.xml', userId: 'u2' },
        ],
      },
    })
    expect(out.urls).toEqual(['https://a.com/f.xml', 'https://b.com/f.xml'])
    expect(out.count).toBe(2)
  })

  it('skips rows with no url', () => {
    const out = urls({ steps: { feeds: [{ userId: 'u1' }, { url: '', userId: 'u1' }] } })
    expect(out.urls).toEqual([])
    expect(out.count).toBe(0)
  })
})

describe('enrich handler — per-subscriber fan-out', () => {
  it('emits one row per subscriber of the entry source', () => {
    const out = fanout(
      [
        { url: 'https://a.com/f.xml', userId: 'u1' },
        { url: 'https://a.com/f.xml', userId: 'u2' },
      ],
      [{ source: 'https://a.com/f.xml', guid: 'g1' }],
    )
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.userId).sort()).toEqual(['u1', 'u2'])
  })

  it('gives each subscriber a distinct dedup key for the same entry', () => {
    const out = fanout(
      [
        { url: 'https://a.com/f.xml', userId: 'u1' },
        { url: 'https://a.com/f.xml', userId: 'u2' },
      ],
      [{ source: 'https://a.com/f.xml', guid: 'g1' }],
    )
    expect(out[0].scopedGuid).not.toBe(out[1].scopedGuid)
    expect(out.map((r) => r.scopedGuid).sort()).toEqual(['u1::g1', 'u2::g1'])
  })

  it('keeps the raw guid intact alongside the scoped key', () => {
    const out = fanout([{ url: 'f', userId: 'u1' }], [{ source: 'f', guid: 'g1' }])
    expect(out[0].guid).toBe('g1')
  })

  it('falls back to link, then to a synthesised key, when guid is absent', () => {
    const byLink = fanout([{ url: 'f', userId: 'u1' }], [{ source: 'f', link: 'L' }])
    expect(byLink[0].scopedGuid).toBe('u1::L')
    const byHash = fanout(
      [{ url: 'f', userId: 'u1' }],
      [{ source: 'f', title: 'T', publishedAt: '2026-01-01T00:00:00.000Z' }],
    )
    expect(byHash[0].scopedGuid).toBe('u1::f|T|2026-01-01T00:00:00.000Z')
  })

  it('drops entries whose feed has no subscriber', () => {
    const out = fanout([{ url: 'https://a.com/f.xml', userId: 'u1' }], [{ source: 'https://other.com/f.xml', guid: 'g' }])
    expect(out).toEqual([])
  })

  it('ignores feed rows with no owner', () => {
    const out = fanout([{ url: 'f' }], [{ source: 'f', guid: 'g' }])
    expect(out).toEqual([])
  })

  it('emits the resolved natural key as itemGuid even when guid and link are absent', () => {
    // Regression: reader_items.guid is `required: true`, but data_upsert_many's
    // required-field check exempts only the dedupField column (scopedGuid), not
    // guid. If the pipeline map still sources `guid` from the raw, possibly-absent
    // e.guid, an entry with neither guid nor link fails validation and is silently
    // dropped (counted as an error the frontend never surfaces). itemGuid must carry
    // the same fallback-resolved key as scopedGuid so `guid: steps.item.itemGuid`
    // always has a value.
    const out = fanout(
      [{ url: 'f', userId: 'u1' }],
      [{ source: 'f', title: 'T', publishedAt: '2026-01-01T00:00:00.000Z' }],
    )
    expect(out[0].itemGuid).toBe('f|T|2026-01-01T00:00:00.000Z')
    expect(out[0].scopedGuid).toBe('u1::' + out[0].itemGuid)
  })

  it('the synthesised key for an entry with no guid/link/date is stable across polls', () => {
    // Regression for enrich.fn.js:42 — the fallback key must be built from stable
    // entry data only, never from `pub` (which falls back to the current stamp),
    // or a re-poll mints a fresh scopedGuid every time and inserts a duplicate row.
    const feeds = [{ url: 'f', userId: 'u1' }]
    const entries = [{ source: 'f', title: 'T' }]
    const first = enrich({ steps: { feeds, parse: { entries }, stamp: { ms: 0 } } }).entries
    const second = enrich({ steps: { feeds, parse: { entries }, stamp: { ms: 900_000 } } }).entries
    expect(first[0].scopedGuid).toBe(second[0].scopedGuid)
  })

  it('the upsert step dedups on scopedGuid and maps the owner', () => {
    const upsert = refreshRule.pipeline?.steps?.find((s) => s.id === 'upsert')
    expect(upsert?.config?.dedupField).toBe('scopedGuid')
    expect(upsert?.config?.dedupKey).toBe('steps.item.scopedGuid')
    expect((upsert?.config?.map as Record<string, unknown>).userId).toBe('steps.item.userId')
    expect(upsert?.config?.updateFields).not.toContain('scopedGuid')
  })

  it('the upsert step maps guid from the resolved itemGuid, not the raw entry guid', () => {
    // Regression: `guid` is a required schema field but data_upsert_many only
    // exempts the dedupField (scopedGuid) from required-field validation. Mapping
    // guid from the raw steps.item.guid (which can be undefined) drops entries
    // with neither a guid nor a link.
    const upsert = refreshRule.pipeline?.steps?.find((s) => s.id === 'upsert')
    expect((upsert?.config?.map as Record<string, unknown>).guid).toBe('steps.item.itemGuid')
  })
})
