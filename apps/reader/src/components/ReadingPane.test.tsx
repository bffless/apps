/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"https://reader.example.com/"}
 *
 * The embed trust gate (`isTrustedEmbedOrigin`) is derived from the reader's own
 * hostname, and jsdom's default `localhost` has no primary domain to derive
 * from, so this file runs at `reader.example.com` and the Handoff fixtures live
 * at `handoff.example.com`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReadingPane } from './ReadingPane'
import { resetSessionConsent } from '../lib/embedConsent'
import type { Item } from '../lib/items'

/**
 * The reading pane iframes a *trusted* Handoff content item (markdown post or
 * HTML site) instead of sanitizing+injecting its body. Two gates apply:
 *
 * 1. `isEmbeddable` (detection + origin trust) — an embeddable mime on a
 *    trusted origin (a subdomain of the reader's own primary domain). Any other
 *    origin falls back to the sanitized body.
 * 2. The consent gate (Outlook-style) — even a trusted embed is hidden until the
 *    reader allows its host (always) or the item (once). Keyed on the parsed
 *    origin, NEVER the feed-supplied mime — so labelling a site `text/markdown`
 *    cannot skip consent.
 */

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    guid: 'g1',
    feedId: 'https://example.com/feed',
    title: 'First article',
    link: 'https://example.com/1',
    author: null,
    publishedAt: '2026-07-01T00:00:00Z',
    summary: 'summary',
    content: '<p>body</p>',
    enclosureType: null,
    read: false,
    starred: false,
    archived: false,
    fetchedAt: 1,
    ...overrides,
  }
}

const markdownItem = (o: Partial<Item> = {}) =>
  makeItem({
    title: 'Handoff post',
    enclosureType: 'text/markdown',
    link: 'https://handoff.example.com/blob/Posts/x.md?token=abc',
    content: '<p>UNIQUE_INLINE_MARKER</p>',
    ...o,
  })

const siteItem = (o: Partial<Item> = {}) =>
  makeItem({
    title: 'Handoff site',
    enclosureType: 'text/html',
    link: 'https://handoff.example.com/blob/Sites/Portfolio',
    ...o,
  })

describe('ReadingPane', () => {
  beforeEach(() => {
    // Isolate consent between tests: clear persisted hosts + session show-once.
    try {
      localStorage.clear()
    } catch {
      /* ignore */
    }
    resetSessionConsent()
  })

  it('gates an embeddable item behind consent: shows the gate, not the iframe', () => {
    const { container } = render(<ReadingPane item={siteItem()} />)

    // No iframe until consent.
    expect(container.querySelector('iframe')).toBeNull()
    // The gate names the host and offers the two actions.
    expect(screen.getByText('Embedded content isn’t shown')).toBeTruthy()
    expect(screen.getByRole('button', { name: /show content/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /always allow handoff\.example\.com/i })).toBeTruthy()
    // Header still renders.
    expect(screen.getByText('Handoff site')).toBeTruthy()
  })

  it('gates a text/markdown item identically — the mime cannot bypass consent', () => {
    const { container } = render(<ReadingPane item={markdownItem()} />)

    // Even markdown is gated (no auto-load, no mime bypass).
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText('Embedded content isn’t shown')).toBeTruthy()
  })

  it('"Show content" reveals the iframe for that item (embed=1 + token preserved)', () => {
    const { container } = render(<ReadingPane item={markdownItem()} />)

    fireEvent.click(screen.getByRole('button', { name: /show content/i }))

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    const src = iframe!.getAttribute('src') ?? ''
    expect(src).toContain('embed=1')
    expect(src).toContain('token=abc')
    // Body is NOT injected inline — the iframe replaces it entirely.
    expect(screen.queryByText('UNIQUE_INLINE_MARKER')).toBeNull()
    // The explicit embed seam (source label + escape hatch) is present.
    expect(screen.getByText('handoff.example.com')).toBeTruthy()
    expect(screen.getByText(/Open original/)).toBeTruthy()
  })

  it('"Show content" is per-item — a different item from the same host is still gated', () => {
    const { container, rerender } = render(<ReadingPane item={siteItem({ guid: 'a' })} />)
    fireEvent.click(screen.getByRole('button', { name: /show content/i }))
    expect(container.querySelector('iframe')).not.toBeNull()

    rerender(<ReadingPane item={siteItem({ guid: 'b', link: 'https://handoff.example.com/blob/Sites/Other' })} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText('Embedded content isn’t shown')).toBeTruthy()
  })

  it('"Always allow <host>" auto-loads later items from that host, incl. after remount', () => {
    const { container, unmount } = render(<ReadingPane item={siteItem({ guid: 'a' })} />)
    fireEvent.click(screen.getByRole('button', { name: /always allow/i }))
    // The current item loads immediately.
    expect(container.querySelector('iframe')).not.toBeNull()
    unmount()

    // A fresh mount (new item, same host) reads the persisted allow-list and
    // auto-loads with no gate.
    const second = render(<ReadingPane item={siteItem({ guid: 'b', link: 'https://handoff.example.com/blob/Sites/Other' })} />)
    expect(second.container.querySelector('iframe')).not.toBeNull()
    expect(screen.queryByText('Embedded content isn’t shown')).toBeNull()
  })

  it('renders the sanitized body and no iframe for a normal (non-embeddable) item', () => {
    const item = makeItem({
      title: 'Plain article',
      enclosureType: null,
      content: '<p>PLAIN_BODY_TEXT</p>',
    })
    const { container } = render(<ReadingPane item={item} />)

    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText('PLAIN_BODY_TEXT')).toBeTruthy()
    expect(screen.getByText('Plain article')).toBeTruthy()
    // Not embeddable → no consent gate either.
    expect(screen.queryByText('Embedded content isn’t shown')).toBeNull()
  })

  it('does NOT embed an item from an untrusted origin — sanitized body, no gate (security)', () => {
    const item = makeItem({
      title: 'Hostile post',
      enclosureType: 'text/markdown',
      link: 'https://evil.com/blob/x',
      content: '<p>SANITIZED_FALLBACK</p>',
    })
    const { container } = render(<ReadingPane item={item} />)

    // The trust gate refuses the non-Handoff origin before consent is even
    // considered: normal sanitized body, no iframe, no gate.
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText('SANITIZED_FALLBACK')).toBeTruthy()
    expect(screen.queryByText('Embedded content isn’t shown')).toBeNull()
  })
})
