import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FeedSidebar } from './FeedSidebar'
import { shapeFeed, type Feed } from '../lib/feeds'
import type { Selection } from '../lib/river'

/**
 * Component-level check for the counts-driven badges (Task 4): the folder,
 * river, and starred badges are rendered straight from the props passed down
 * from `ReaderApp` (`unreadCounts`/`riverUnread`/`starredCount`) — never from a
 * loaded item array. `folderUnread` itself is already unit-tested in
 * `lib/folders.test.ts`; this asserts the sidebar actually wires it through to
 * pixels.
 */

function feed(over: Partial<Feed> & { url: string }): Feed {
  return shapeFeed({ ...over })
}

const FEEDS: Feed[] = [
  feed({ url: 'https://a.test/rss', title: 'Alpha', folder: 'News' }),
  feed({ url: 'https://b.test/rss', title: 'Bravo', folder: 'News' }),
]

const RIVER_SELECTION: Selection = { kind: 'river' }

const noop = () => {}
const noopAsync = async () => {}

function renderSidebar(overrides: Partial<Parameters<typeof FeedSidebar>[0]> = {}) {
  return render(
    <FeedSidebar
      feeds={FEEDS}
      selection={RIVER_SELECTION}
      unreadCounts={{ 'https://a.test/rss': 3, 'https://b.test/rss': 2 }}
      riverUnread={11}
      starredCount={7}
      onSelect={noop}
      onAdd={noopAsync}
      onRemove={noop}
      onMoveFolder={noop}
      onRefresh={noop}
      onImportOpml={noopAsync}
      adding={false}
      importing={false}
      refreshing={false}
      {...overrides}
    />,
  )
}

describe('FeedSidebar — counts-driven badges', () => {
  it('sums a folder badge from its feeds’ unread counts', () => {
    renderSidebar()
    // Alpha (3) + Bravo (2) = 5, rolled up via `folderUnread` — distinct from
    // riverUnread (11) so the assertion can't accidentally match the wrong badge.
    const folderRow = screen.getByTitle('News').closest('div')
    expect(folderRow).toHaveTextContent('5')
    expect(folderRow?.querySelector('span[aria-label="5 unread"]')).toBeInTheDocument()
  })

  it('renders per-feed badges from unreadCounts', () => {
    renderSidebar()
    expect(screen.getByTitle('Alpha').closest('div')).toHaveTextContent('3')
    expect(screen.getByTitle('Bravo').closest('div')).toHaveTextContent('2')
  })

  it('renders the river badge from riverUnread', () => {
    renderSidebar()
    expect(screen.getByTitle('River').closest('div')).toHaveTextContent('11')
  })

  it('renders the starred badge from starredCount', () => {
    renderSidebar()
    expect(screen.getByTitle('★ Starred').closest('div')).toHaveTextContent('7')
  })

  it('does not render badges for an all-zero counts map', () => {
    renderSidebar({ unreadCounts: {}, riverUnread: 0, starredCount: 0 })
    // With empty counts, no unread badges render at all (only positive counts show).
    expect(screen.queryByLabelText(/unread/)).not.toBeInTheDocument()
  })
})
