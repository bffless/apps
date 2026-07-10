import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// Component tests mock the studioApi module directly — no Redux Provider / MSW
// (matches SourceQueue.test.tsx). The spy captures what FinalCutBar asks to sign.
const { signAttachmentSpy } = vi.hoisted(() => ({ signAttachmentSpy: vi.fn() }))

vi.mock('../../store/studioApi', () => ({
  useSignDownloadQuery: () => ({ data: undefined }),
  // Used internally by useSignedBytes (FinalCutBar's assemble step); not
  // exercised by these tests, which never trigger `run()`.
  useLazySignDownloadQuery: () => [vi.fn()],
  useSignAttachmentQuery: (arg: unknown) => {
    signAttachmentSpy(arg)
    if (arg && typeof arg === 'object' && 'filename' in arg) {
      const { url, filename } = arg as { url: string; filename: string }
      const signed = new URL(`https://bucket.example.com${url}`)
      signed.searchParams.set(
        'response-content-disposition',
        `attachment; filename="${filename}"`,
      )
      return { data: { url: signed.toString() } }
    }
    return { data: undefined }
  },
}))

import { FinalCutBar } from './FinalCutBar'

const scenes = [
  { id: 's1', index: 0, title: 'One', assembledUrl: '/api/uploads/a.mp4' },
] as never

const baseProps = {
  scenes,
  title: 'Custom AI Content Pipeline',
  finalCutUrl: '/api/uploads/projects/p1/export/final.mp4',
  saving: false,
  onSave: async () => '',
}

describe('FinalCutBar download', () => {
  it('points the download at the signed bucket URL, not the serve path', () => {
    render(<FinalCutBar {...baseProps} />)
    const link = screen.getByRole('link', { name: /download mp4/i })
    const href = link.getAttribute('href') ?? ''
    expect(href).toContain('bucket.example.com')
    expect(href).not.toMatch(/^\/api\/uploads\//)
  })

  it('signs the saved cut for attachment with the title-derived filename', () => {
    render(<FinalCutBar {...baseProps} />)
    expect(signAttachmentSpy).toHaveBeenCalledWith({
      url: '/api/uploads/projects/p1/export/final.mp4',
      filename: 'custom-ai-content-pipeline.mp4',
    })
  })

  it('names the download after the video title', () => {
    render(<FinalCutBar {...baseProps} />)
    const link = screen.getByRole('link', { name: /download mp4/i })
    expect(link).toHaveAttribute('download', 'custom-ai-content-pipeline.mp4')
    const href = link.getAttribute('href') ?? ''
    const disposition = new URL(href).searchParams.get('response-content-disposition')
    expect(disposition).toBe('attachment; filename="custom-ai-content-pipeline.mp4"')
  })
})
