/**
 * Map a file's name/mime to a coarse "leaf kind", used to pick its listing
 * glyph. Pure and independently testable; kept out of the icon component file so
 * that file can export only components (react-refresh).
 */

export type LeafKind = 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'file'

export function leafKind(name: string, mime: string | null): LeafKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const m = mime ?? ''
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext))
    return 'image'
  if (m.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'video'
  if (m.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio'
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown'
  return 'file'
}
