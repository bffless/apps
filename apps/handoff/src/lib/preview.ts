import type { NodeType } from './nodes'

export type PreviewKind = 'site' | 'pdf' | 'image' | 'markdown' | 'video' | 'audio' | 'download'

export function previewFor(node: { type: NodeType; mime: string | null; name?: string }): PreviewKind {
  if (node.type === 'site') return 'site'

  const mime = node.mime?.toLowerCase() ?? ''

  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'text/markdown') return 'markdown'

  // markdown by extension when mime is octet-stream or null
  if (mime === '' || mime === 'application/octet-stream') {
    const name = node.name?.toLowerCase() ?? ''
    if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown'
  }

  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'

  return 'download'
}

/**
 * Whether a "View source" toggle is meaningful for this preview kind.
 *
 * True only for kinds that have a *rendered* view whose underlying text source
 * is worth inspecting: a Site entry's HTML and rendered Markdown. Images, PDFs,
 * audio, video, and unsupported downloads have no meaningful text source, so the
 * toggle is hidden for them.
 */
export function hasViewSource(kind: PreviewKind): boolean {
  return kind === 'site' || kind === 'markdown'
}
