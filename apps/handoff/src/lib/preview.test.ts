import { describe, it, expect } from 'vitest'
import { previewFor, hasViewSource } from './preview'

describe('previewFor', () => {
  // site wins regardless of mime
  it('returns site for type=site', () => {
    expect(previewFor({ type: 'site', mime: null })).toBe('site')
  })
  it('returns site for type=site even with pdf mime', () => {
    expect(previewFor({ type: 'site', mime: 'application/pdf' })).toBe('site')
  })

  // pdf
  it('returns pdf for application/pdf', () => {
    expect(previewFor({ type: 'file', mime: 'application/pdf' })).toBe('pdf')
  })
  it('returns pdf case-insensitively', () => {
    expect(previewFor({ type: 'file', mime: 'Application/PDF' })).toBe('pdf')
  })

  // image
  it('returns image for image/png', () => {
    expect(previewFor({ type: 'file', mime: 'image/png' })).toBe('image')
  })
  it('returns image for image/jpeg', () => {
    expect(previewFor({ type: 'file', mime: 'image/jpeg' })).toBe('image')
  })
  it('returns image for image/gif', () => {
    expect(previewFor({ type: 'file', mime: 'image/gif' })).toBe('image')
  })
  it('returns image for image/webp', () => {
    expect(previewFor({ type: 'file', mime: 'image/webp' })).toBe('image')
  })
  it('returns image case-insensitively', () => {
    expect(previewFor({ type: 'file', mime: 'Image/PNG' })).toBe('image')
  })

  // markdown by mime
  it('returns markdown for text/markdown', () => {
    expect(previewFor({ type: 'file', mime: 'text/markdown' })).toBe('markdown')
  })
  it('returns markdown for text/markdown case-insensitively', () => {
    expect(previewFor({ type: 'file', mime: 'Text/Markdown' })).toBe('markdown')
  })
  // markdown by extension when mime is octet-stream
  it('returns markdown for .md extension with octet-stream mime', () => {
    expect(previewFor({ type: 'file', mime: 'application/octet-stream', name: 'readme.md' })).toBe('markdown')
  })
  it('returns markdown for .markdown extension with octet-stream mime', () => {
    expect(previewFor({ type: 'file', mime: 'application/octet-stream', name: 'notes.markdown' })).toBe('markdown')
  })
  it('returns markdown for .md extension with null mime', () => {
    expect(previewFor({ type: 'file', mime: null, name: 'readme.md' })).toBe('markdown')
  })
  it('does NOT return markdown for .md extension when mime is set (non-octet-stream)', () => {
    expect(previewFor({ type: 'file', mime: 'text/plain', name: 'readme.md' })).toBe('download')
  })

  // video
  it('returns video for video/mp4', () => {
    expect(previewFor({ type: 'file', mime: 'video/mp4' })).toBe('video')
  })
  it('returns video for video/webm', () => {
    expect(previewFor({ type: 'file', mime: 'video/webm' })).toBe('video')
  })

  // audio
  it('returns audio for audio/mpeg', () => {
    expect(previewFor({ type: 'file', mime: 'audio/mpeg' })).toBe('audio')
  })
  it('returns audio for audio/ogg', () => {
    expect(previewFor({ type: 'file', mime: 'audio/ogg' })).toBe('audio')
  })

  // download fallback
  it('returns download for text/plain', () => {
    expect(previewFor({ type: 'file', mime: 'text/plain' })).toBe('download')
  })
  it('returns download for application/zip', () => {
    expect(previewFor({ type: 'file', mime: 'application/zip' })).toBe('download')
  })
  it('returns download for null mime with no md extension', () => {
    expect(previewFor({ type: 'file', mime: null })).toBe('download')
  })
  it('returns download for null mime with docx name', () => {
    expect(previewFor({ type: 'file', mime: null, name: 'doc.docx' })).toBe('download')
  })
  it('returns download for unknown mime', () => {
    expect(previewFor({ type: 'file', mime: 'application/x-whatever' })).toBe('download')
  })
  it('returns download for folder type', () => {
    expect(previewFor({ type: 'folder', mime: null })).toBe('download')
  })
})

describe('hasViewSource', () => {
  it('is true for site', () => {
    expect(hasViewSource('site')).toBe(true)
  })
  it('is true for markdown', () => {
    expect(hasViewSource('markdown')).toBe(true)
  })
  it('is false for image', () => {
    expect(hasViewSource('image')).toBe(false)
  })
  it('is false for pdf', () => {
    expect(hasViewSource('pdf')).toBe(false)
  })
  it('is false for video', () => {
    expect(hasViewSource('video')).toBe(false)
  })
  it('is false for audio', () => {
    expect(hasViewSource('audio')).toBe(false)
  })
  it('is false for download', () => {
    expect(hasViewSource('download')).toBe(false)
  })
})
