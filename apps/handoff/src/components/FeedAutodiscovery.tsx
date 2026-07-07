import { useEffect } from 'react'

/**
 * Injects an RSS autodiscovery `<link rel="alternate" type="application/rss+xml">`
 * into the document head so a reader can find a folder's Feed from the folder
 * page's URL alone (ADR-0008 autodiscovery).
 *
 * Render this ONLY for an effectively-public folder: a discoverable link must
 * never carry a share token, so the private (tokened) feed URL is never
 * advertised. Callers gate on the same effective-public signal the badge/tints
 * use (`isEffectivelyPublic`), so cutting off inherited public access unmounts
 * this component — its cleanup removes the link, taking autodiscovery with it.
 * The `href` is whatever `feedUrl()` produces (tokenless).
 */
export function FeedAutodiscovery({ href, title }: { href: string; title: string }) {
  useEffect(() => {
    const link = document.createElement('link')
    link.rel = 'alternate'
    link.type = 'application/rss+xml'
    link.title = title
    link.href = href
    link.setAttribute('data-feed-autodiscovery', '')
    document.head.appendChild(link)
    return () => {
      link.remove()
    }
  }, [href, title])

  return null
}
