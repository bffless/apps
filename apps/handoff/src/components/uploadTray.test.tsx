import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { UploadTray } from './UploadTray'
import {
  beginUpload,
  setUploadProgress,
  completeUpload,
  failUpload,
  registerAbort,
  getUploads,
  resetUploadsForTest,
} from '../lib/uploads'

const MB = 1024 * 1024

beforeEach(() => {
  resetUploadsForTest()
})

describe('UploadTray', () => {
  it('renders nothing when no uploads are in play', () => {
    const { container } = render(<UploadTray />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a queued file the moment it is registered, before any bytes move', () => {
    render(<UploadTray />)
    act(() => {
      beginUpload({ name: 'demo-recording.mp4', size: 300 * MB })
    })
    expect(screen.getByText('demo-recording.mp4')).toBeInTheDocument()
    expect(screen.getByText('Queued')).toBeInTheDocument()
  })

  it('reports percent and bytes while uploading', () => {
    render(<UploadTray />)
    let id = ''
    act(() => {
      id = beginUpload({ name: 'demo-recording.mp4', size: 300 * MB })
    })
    act(() => setUploadProgress(id, 150 * MB))

    expect(screen.getByText('150 MB of 300 MB')).toBeInTheDocument()
    const bar = screen.getByRole('progressbar', { name: /demo-recording\.mp4/ })
    expect(bar).toHaveAttribute('aria-valuenow', '50')
  })

  it('says "Finishing…" once the bytes are out but the node is not registered yet', () => {
    render(<UploadTray />)
    let id = ''
    act(() => {
      id = beginUpload({ name: 'demo-recording.mp4', size: 300 * MB })
    })
    act(() => setUploadProgress(id, 300 * MB))
    expect(screen.getByText('Finishing…')).toBeInTheDocument()
  })

  it('shows a file counter and aggregate bytes for a folder import', () => {
    render(<UploadTray />)
    let id = ''
    act(() => {
      id = beginUpload({ name: 'my-site', size: 10 * MB, fileCount: 40 })
    })
    act(() => setUploadProgress(id, 5 * MB, { fileIndex: 12 }))

    expect(screen.getByText('my-site')).toBeInTheDocument()
    expect(screen.getByText('12 of 40 files · 5 MB of 10 MB')).toBeInTheDocument()
  })

  it('summarises live uploads in the header', () => {
    render(<UploadTray />)
    act(() => {
      beginUpload({ name: 'a.png', size: 10 })
      beginUpload({ name: 'b.png', size: 10 })
    })
    expect(screen.getByText('Uploading 2 files')).toBeInTheDocument()
  })

  it('marks a finished upload done and a failed one with its message', () => {
    render(<UploadTray />)
    let ok = ''
    let bad = ''
    act(() => {
      ok = beginUpload({ name: 'screenshot.png', size: 10 })
      bad = beginUpload({ name: 'broken.png', size: 10 })
    })
    act(() => {
      completeUpload(ok)
      failUpload(bad, 'Bucket upload failed (500)')
    })

    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText('Bucket upload failed (500)')).toBeInTheDocument()
    expect(screen.getByText('1 upload failed')).toBeInTheDocument()
  })

  it('cancel aborts the live transfer', () => {
    render(<UploadTray />)
    let id = ''
    const abort = vi.fn()
    act(() => {
      id = beginUpload({ name: 'demo-recording.mp4', size: 300 * MB })
      registerAbort(id, abort)
    })
    act(() => setUploadProgress(id, 10))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload of demo-recording.mp4' }))

    expect(abort).toHaveBeenCalledOnce()
    expect(screen.getByText('Canceled')).toBeInTheDocument()
  })

  it('offers no cancel button once an upload has finished', () => {
    render(<UploadTray />)
    let id = ''
    act(() => {
      id = beginUpload({ name: 'screenshot.png', size: 10 })
    })
    act(() => completeUpload(id))
    expect(screen.queryByRole('button', { name: /^Cancel upload/ })).not.toBeInTheDocument()
  })

  it('the header close button clears finished uploads but leaves live ones', () => {
    render(<UploadTray />)
    let live = ''
    let done = ''
    act(() => {
      live = beginUpload({ name: 'live.mp4', size: 300 * MB })
      done = beginUpload({ name: 'done.png', size: 10 })
    })
    act(() => {
      setUploadProgress(live, 1)
      completeUpload(done)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Clear finished uploads' }))

    expect(screen.queryByText('done.png')).not.toBeInTheDocument()
    expect(screen.getByText('live.mp4')).toBeInTheDocument()
    expect(getUploads()).toHaveLength(1)
  })

  it('collapses and expands the list without dropping the uploads', () => {
    render(<UploadTray />)
    act(() => {
      beginUpload({ name: 'demo-recording.mp4', size: 300 * MB })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Collapse uploads' }))
    expect(screen.queryByText('demo-recording.mp4')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Expand uploads' }))
    expect(screen.getByText('demo-recording.mp4')).toBeInTheDocument()
  })
})
