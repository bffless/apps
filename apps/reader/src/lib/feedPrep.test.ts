/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const setRoot = resolve(process.cwd(), '.bffless/proxy-rules/reader')
const prepSource = readFileSync(resolve(setRoot, 'rules/api/feeds/post/prep.fn.js'), 'utf8')
const addRule = parse(
  readFileSync(resolve(setRoot, 'rules/api/feeds/post/rule.yaml'), 'utf8'),
) as { pipeline?: { steps?: Array<{ id: string; config?: Record<string, unknown> }> } }

type PrepOut = {
  feeds: Array<{ userId: string; scopedUrl: string; url: string; folder: string | null }>
  hasUrl: boolean
  noUrl: boolean
}
type PrepHandler = (arg: {
  user?: { id: string }
  request: { body: Record<string, unknown> }
}) => PrepOut

const prep = new Function('return (' + prepSource + ')')() as PrepHandler

describe('add-feed prep — per-user scoping', () => {
  it('stamps the caller as owner and builds a per-user dedup key', () => {
    const out = prep({ user: { id: 'u1' }, request: { body: { url: 'https://a.com/f.xml' } } })
    expect(out.feeds[0].userId).toBe('u1')
    expect(out.feeds[0].scopedUrl).toBe('u1::https://a.com/f.xml')
    expect(out.feeds[0].url).toBe('https://a.com/f.xml')
    expect(out.hasUrl).toBe(true)
  })

  it('gives two users distinct dedup keys for the same feed', () => {
    const a = prep({ user: { id: 'u1' }, request: { body: { url: 'https://a.com/f.xml' } } })
    const b = prep({ user: { id: 'u2' }, request: { body: { url: 'https://a.com/f.xml' } } })
    expect(a.feeds[0].scopedUrl).not.toBe(b.feeds[0].scopedUrl)
  })

  it('rejects a userless call rather than writing an unowned row', () => {
    const out = prep({ request: { body: { url: 'https://a.com/f.xml' } } })
    expect(out.hasUrl).toBe(false)
    expect(out.noUrl).toBe(true)
  })

  it('still rejects a missing url', () => {
    const out = prep({ user: { id: 'u1' }, request: { body: {} } })
    expect(out.hasUrl).toBe(false)
    expect(out.noUrl).toBe(true)
  })

  it('preserves existing folder normalisation', () => {
    const out = prep({ user: { id: 'u1' }, request: { body: { url: 'u', folder: '' } } })
    expect(out.feeds[0].folder).toBeNull()
  })

  it('the upsert step dedups on scopedUrl, not url', () => {
    const upsert = addRule.pipeline?.steps?.find((s) => s.id === 'upsert')
    expect(upsert?.config?.dedupField).toBe('scopedUrl')
    expect(upsert?.config?.dedupKey).toBe('steps.item.scopedUrl')
    expect((upsert?.config?.map as Record<string, unknown>).userId).toBe('steps.item.userId')
  })
})
