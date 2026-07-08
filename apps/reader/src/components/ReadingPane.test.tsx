import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReadingPane } from './ReadingPane'
import type { Item } from '../lib/items'

/**
 * The reading pane iframes a *trusted* Handoff markdown post's body instead of
 * sanitizing+injecting it. These assert the branch is picked on the security
 * gate (`isEmbeddable`): trusted markdown → real `<iframe>` (never the sanitized
 * body div); everything else → the unchanged sanitized body, no iframe.
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
    fetchedAt: 1,
    ...overrides,
  }
}

describe('ReadingPane', () => {
  it('renders an iframe (not the sanitized body) for a trusted markdown item', () => {
    const item = makeItem({
      title: 'Handoff post',
      enclosureType: 'text/markdown',
      link: 'https://handoff.j5s.dev/blob/Posts/x.md?token=abc',
      content: '<p>UNIQUE_INLINE_MARKER</p>',
    })
    const { container } = render(<ReadingPane item={item} />)

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    const src = iframe!.getAttribute('src') ?? ''
    expect(src).toContain('embed=1')
    expect(src).toContain('token=abc')

    // The raw body must NOT be injected inline — the iframe replaces it entirely.
    expect(screen.queryByText('UNIQUE_INLINE_MARKER')).toBeNull()
    // Header still renders (title link).
    expect(screen.getByText('Handoff post')).toBeTruthy()
    // The embed seam is made explicit: a source label naming the Handoff host and
    // an "Open original" escape hatch, so the iframe's own scroll reads as an
    // intentional embedded document rather than a subtly-broken page.
    expect(screen.getByText('handoff.j5s.dev')).toBeTruthy()
    expect(screen.getByText(/Open original/)).toBeTruthy()
  })

  it('renders the sanitized body and no iframe for a normal item', () => {
    const item = makeItem({
      title: 'Plain article',
      enclosureType: null,
      content: '<p>PLAIN_BODY_TEXT</p>',
    })
    const { container } = render(<ReadingPane item={item} />)

    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText('PLAIN_BODY_TEXT')).toBeTruthy()
    // Header still renders.
    expect(screen.getByText('Plain article')).toBeTruthy()
  })

  it('does NOT iframe a markdown item whose link is an untrusted origin (security)', () => {
    const item = makeItem({
      title: 'Hostile post',
      enclosureType: 'text/markdown',
      link: 'https://evil.com/blob/x',
      content: '<p>SANITIZED_FALLBACK</p>',
    })
    const { container } = render(<ReadingPane item={item} />)

    // The trust gate refuses the non-Handoff origin: normal sanitized body, no iframe.
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText('SANITIZED_FALLBACK')).toBeTruthy()
  })
})
