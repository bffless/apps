import { describe, it, expect } from 'vitest'
import { parseOpml, generateOpml, type OpmlFeed } from './opml'
import { shapeFeed, type Feed } from './feeds'

/** A feed factory keyed off the shaper so defaults match production shaping. */
function feed(over: Partial<Feed> & { url: string }): Feed {
  return shapeFeed({ ...over })
}

/** A typical multi-folder export (the shape most readers emit). */
const NESTED_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Subscriptions</title></head>
  <body>
    <outline text="News" title="News">
      <outline type="rss" text="Alpha" title="Alpha" xmlUrl="https://a.test/rss" htmlUrl="https://a.test"/>
      <outline type="rss" text="Bravo" xmlUrl="https://b.test/feed"/>
    </outline>
    <outline type="rss" text="Charlie" xmlUrl="https://c.test/atom.xml"/>
  </body>
</opml>`

describe('parseOpml', () => {
  it('reads feeds and carries their containing folder', () => {
    expect(parseOpml(NESTED_OPML)).toEqual<OpmlFeed[]>([
      { url: 'https://a.test/rss', title: 'Alpha', folder: 'News' },
      { url: 'https://b.test/feed', title: 'Bravo', folder: 'News' },
      { url: 'https://c.test/atom.xml', title: 'Charlie', folder: null },
    ])
  })

  it('normalizes urls and dedupes (first outline wins)', () => {
    const xml = `<opml><body>
      <outline type="rss" text="One" xmlUrl="HTTPS://Dup.test/Feed/"/>
      <outline type="rss" text="Two" xmlUrl="https://dup.test/Feed"/>
      <outline type="rss" text="Bare" xmlUrl="bare.test/rss"/>
    </body></opml>`
    expect(parseOpml(xml)).toEqual<OpmlFeed[]>([
      { url: 'https://dup.test/Feed', title: 'One', folder: null },
      { url: 'https://bare.test/rss', title: 'Bare', folder: null },
    ])
  })

  it('prefers the title attr, falling back to text, then empty', () => {
    const xml = `<opml><body>
      <outline title="T" text="X" xmlUrl="https://t.test/rss"/>
      <outline text="OnlyText" xmlUrl="https://x.test/rss"/>
      <outline xmlUrl="https://n.test/rss"/>
    </body></opml>`
    expect(parseOpml(xml).map((f) => f.title)).toEqual(['T', 'OnlyText', ''])
  })

  it('skips container outlines and unparseable / non-http urls', () => {
    const xml = `<opml><body>
      <outline text="EmptyFolder"></outline>
      <outline type="rss" text="Bad" xmlUrl="::::"/>
      <outline type="rss" text="Mail" xmlUrl="mailto:a@b.test"/>
      <outline type="rss" text="Good" xmlUrl="https://good.test/rss"/>
    </body></opml>`
    expect(parseOpml(xml)).toEqual<OpmlFeed[]>([
      { url: 'https://good.test/rss', title: 'Good', folder: null },
    ])
  })

  it('returns [] for malformed or empty input', () => {
    expect(parseOpml('<opml><body><outline')).toEqual([])
    expect(parseOpml('not xml at all <<<')).toEqual([])
    expect(parseOpml('')).toEqual([])
  })
})

describe('generateOpml', () => {
  const feeds: Feed[] = [
    feed({ url: 'https://a.test/rss', title: 'Alpha', siteUrl: 'https://a.test', folder: 'News' }),
    feed({ url: 'https://b.test/rss', title: 'Bravo', folder: 'news' }), // same folder, mixed case
    feed({ url: 'https://c.test/rss', title: 'Charlie' }), // uncategorized
  ]

  it('emits valid OPML that round-trips back through parseOpml', () => {
    const xml = generateOpml(feeds)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<opml version="2.0">')
    // Round-tripping is the strongest "is this valid OPML" assertion: the parser
    // recovers every subscription with its (case-normalized) folder preserved.
    expect(parseOpml(xml)).toEqual<OpmlFeed[]>([
      { url: 'https://a.test/rss', title: 'Alpha', folder: 'News' },
      { url: 'https://b.test/rss', title: 'Bravo', folder: 'News' },
      { url: 'https://c.test/rss', title: 'Charlie', folder: null },
    ])
  })

  it('labels an untitled feed from its url so the export still reads well', () => {
    const xml = generateOpml([feed({ url: 'https://noname.test/feed' })])
    expect(xml).toContain('text="noname.test/feed"')
  })

  it('escapes XML-special characters in titles and urls', () => {
    const xml = generateOpml([
      feed({ url: 'https://x.test/rss?a=1&b=2', title: 'Tom & <Jerry>', folder: 'A & B' }),
    ])
    expect(xml).toContain('title="Tom &amp; &lt;Jerry&gt;"')
    expect(xml).toContain('xmlUrl="https://x.test/rss?a=1&amp;b=2"')
    expect(xml).toContain('text="A &amp; B"')
    // And it survives the round-trip unescaped.
    expect(parseOpml(xml)).toEqual<OpmlFeed[]>([
      { url: 'https://x.test/rss?a=1&b=2', title: 'Tom & <Jerry>', folder: 'A & B' },
    ])
  })
})
