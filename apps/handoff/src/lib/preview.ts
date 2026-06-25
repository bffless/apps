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
