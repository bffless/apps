import { describe, expect, it } from 'vitest'
import {
  commonFeedPaths,
  isFeedContent,
  parseFeedLinks,
  resolveFeedUrl,
  type FetchedPage,
} from './discover'

describe('isFeedContent', () => {
  it('detects an RSS document by its root element', () => {
    expect(isFeedContent('<?xml version="1.0"?>\n<rss version="2.0"><channel/></rss>', null)).toBe(true)
  })

  it('detects an Atom document', () => {
    expect(isFeedContent('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', null)).toBe(true)
  })

  it('detects an RDF (RSS 1.0) document', () => {
    expect(isFeedContent('<rdf:RDF xmlns:rdf="..."></rdf:RDF>', null)).toBe(true)
  })

  it('detects a JSON feed', () => {
    expect(isFeedContent('{"version":"https://jsonfeed.org/version/1.1","items":[]}', null)).toBe(true)
  })

  it('looks past a leading BOM, XML declaration and comments', () => {
    const body = '﻿<?xml version="1.0" encoding="utf-8"?>\n<!-- built by hand -->\n<rss><channel/></rss>'
    expect(isFeedContent(body, null)).toBe(true)
  })

  it('trusts a feed content-type even when the body was not sniffable', () => {
    expect(isFeedContent('not obviously xml', 'application/rss+xml; charset=utf-8')).toBe(true)
    expect(isFeedContent('...', 'application/atom+xml')).toBe(true)
  })

  it('rejects an HTML page', () => {
    expect(isFeedContent('<!doctype html><html><head></head><body>hi</body></html>', 'text/html')).toBe(false)
  })

  it('rejects empty / junk input', () => {
    expect(isFeedContent('', null)).toBe(false)
    expect(isFeedContent('   ', null)).toBe(false)
  })
})

describe('parseFeedLinks', () => {
  const base = 'https://example.com/blog'

  it('extracts an rss alternate link and resolves it absolutely', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
    </head></html>`
    expect(parseFeedLinks(html, base)).toEqual([
      { url: 'https://example.com/feed.xml', title: 'RSS' },
    ])
  })

  it('extracts atom and json-feed alternates too, in document order', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/atom+xml" href="https://example.com/atom">
      <link rel="alternate" type="application/feed+json" href="https://example.com/feed.json">
    </head></html>`
    expect(parseFeedLinks(html, base).map((l) => l.url)).toEqual([
      'https://example.com/atom',
      'https://example.com/feed.json',
    ])
  })

  it('ignores non-feed alternates (stylesheets, canonical, other types)', () => {
    const html = `<html><head>
      <link rel="alternate" type="text/html" href="/amp">
      <link rel="stylesheet" href="/style.css">
      <link rel="canonical" href="/blog">
    </head></html>`
    expect(parseFeedLinks(html, base)).toEqual([])
  })

  it('dedupes repeated hrefs (first wins)', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="A" href="/feed">
      <link rel="alternate" type="application/rss+xml" title="B" href="/feed">
    </head></html>`
    expect(parseFeedLinks(html, base)).toEqual([{ url: 'https://example.com/feed', title: 'A' }])
  })

  it('returns [] for input with no head links', () => {
    expect(parseFeedLinks('<html><body>nothing here</body></html>', base)).toEqual([])
  })
})

describe('commonFeedPaths', () => {
  it('probes the well-known feed paths against the site origin', () => {
    expect(commonFeedPaths('https://example.com/blog/post')).toEqual([
      'https://example.com/feed',
      'https://example.com/rss',
      'https://example.com/atom.xml',
      'https://example.com/feed.xml',
    ])
  })
})

/** Build a fetcher over a fixture map, recording every URL it is asked for. */
function fakeFetcher(pages: Record<string, Partial<FetchedPage>>) {
  const calls: string[] = []
  const fetch = async (url: string): Promise<FetchedPage> => {
    calls.push(url)
    const p = pages[url]
    if (!p) return { url, body: '<html><body>404</body></html>', contentType: 'text/html', ok: false }
    return { url, body: '', contentType: null, ok: true, ...p }
  }
  return { fetch, calls }
}

describe('resolveFeedUrl', () => {
  it('adds a URL that is already a feed directly, without probing', async () => {
    const { fetch, calls } = fakeFetcher({
      'https://example.com/feed.xml': { body: '<rss version="2.0"><channel/></rss>' },
    })
    const found = await resolveFeedUrl('example.com/feed.xml', fetch)
    expect(found.url).toBe('https://example.com/feed.xml')
    // Only the one fetch — no alternate parse, no common-path probing.
    expect(calls).toEqual(['https://example.com/feed.xml'])
  })

  it('discovers the feed via the page alternate link', async () => {
    const { fetch, calls } = fakeFetcher({
      'https://example.com/': {
        body: '<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head></html>',
      },
    })
    const found = await resolveFeedUrl('example.com', fetch)
    expect(found.url).toBe('https://example.com/rss.xml')
    expect(calls).toEqual(['https://example.com/']) // resolved from HTML, no probing
  })

  it('falls back to common paths when the page has no alternate link', async () => {
    const { fetch, calls } = fakeFetcher({
      'https://example.com/': { body: '<html><head><title>No feed link</title></head></html>' },
      'https://example.com/rss': { body: '<rss version="2.0"><channel/></rss>' },
    })
    const found = await resolveFeedUrl('example.com', fetch)
    expect(found.url).toBe('https://example.com/rss')
    // Probed /feed (miss) then /rss (hit), stopping at the first feed.
    expect(calls).toEqual(['https://example.com/', 'https://example.com/feed', 'https://example.com/rss'])
  })

  it('throws a clear error when nothing looks like a feed', async () => {
    const { fetch } = fakeFetcher({
      'https://example.com/': { body: '<html><head></head><body>just a page</body></html>' },
    })
    await expect(resolveFeedUrl('example.com', fetch)).rejects.toThrow(/no feed/i)
  })

  it('rejects an unusable URL before any fetch', async () => {
    const { fetch, calls } = fakeFetcher({})
    await expect(resolveFeedUrl('   ', fetch)).rejects.toThrow(/valid/i)
    expect(calls).toEqual([])
  })
})
