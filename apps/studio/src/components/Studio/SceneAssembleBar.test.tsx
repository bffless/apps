/**
 * SceneAssembleBar — two things the card must get right:
 *
 * 1. What it says about a scene that rendered but did NOT save. The failure that
 *    opened issue #220: the producer assembled a scene by hand to fix a halted
 *    auto-build, the upload failed, and the card still looked like a saved scene
 *    (a video preview, a working Download link). They moved on believing it was
 *    saved. A rendered-but-unsaved scene must never read as a saved one.
 *
 * 2. Where the Download link of a SAVED scene points (#421). A reloaded scene has
 *    no local blob, so the link must be a signed `attachment` bucket URL — never
 *    the `/api/uploads/...` serve path, which streams the whole MP4 through
 *    file_serve (504/OOM on big files). Mirrors FinalCutBar.test.tsx.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

// Component tests mock the studioApi module directly — no Redux Provider / MSW
// (matches FinalCutBar.test.tsx / SourceQueue.test.tsx). The spy captures what
// SceneAssembleBar asks to sign for the download.
const { signAttachmentSpy } = vi.hoisted(() => ({ signAttachmentSpy: vi.fn() }))

vi.mock('../../store/studioApi', () => ({
  useSignDownloadQuery: () => ({ data: undefined }),
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

const { assembleSceneBlobMock } = vi.hoisted(() => ({ assembleSceneBlobMock: vi.fn() }))
vi.mock('../../lib/export/assembleScene', () => ({ assembleSceneBlob: assembleSceneBlobMock }))

import { SceneAssembleBar } from './SceneAssembleBar'
import type { Scene } from '../../lib/scenes'

const scene: Scene = {
  id: 's1',
  index: 0,
  sourceId: 'source-1',
  title: 'Scene 1',
  start: 0,
  end: 30,
  transcript: 'hello world',
  status: 'pending',
  clipUrl: 's1-clip.mp4',
  clipAudioUrl: 's1-clip.wav',
  cuts: [{ start: 5, end: 10 }],
}

/** Render the bar, assemble the scene, then click Save (whose outcome the test sets). */
async function assembleThenSave(onSave: (blob: Blob) => Promise<string>) {
  assembleSceneBlobMock.mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }))
  render(
    <SceneAssembleBar
      scene={scene}
      saving={false}
      onSave={onSave}
      onAssembleServer={async () => {}}
      onPreview={() => {}}
    />,
  )
  await act(async () => {
    screen.getByRole('button', { name: /assemble scene/i }).click()
  })
  await act(async () => {
    screen.getByRole('button', { name: /save this scene/i }).click()
  })
}

describe('SceneAssembleBar — a save that fails', () => {
  it('says the scene is not saved, and keeps Save on offer to retry', async () => {
    await assembleThenSave(() => Promise.reject(new Error('Failed to fetch')))

    expect(screen.getByText(/couldn’t save/i)).toBeTruthy()
    expect(screen.getByText(/not saved/i)).toBeTruthy()
    // The claim of success must be absent — this is the bit that misled the reporter.
    expect(screen.queryByText(/✓ Saved/)).toBeNull()
    // …and the retry is still one click away.
    expect(screen.getByRole('button', { name: /save this scene/i })).toBeTruthy()
  })

  it('confirms the save once it lands, and drops the unsaved warning', async () => {
    await assembleThenSave(() => Promise.resolve('/api/uploads/s1.mp4'))

    expect(screen.getByText(/✓ Saved/)).toBeTruthy()
    expect(screen.queryByText(/couldn’t save/i)).toBeNull()
    expect(screen.queryByText(/not saved/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /save this scene/i })).toBeNull()
  })
})

describe('SceneAssembleBar — downloading a SAVED scene (#421)', () => {
  // A previously-saved scene reloaded from the project: no local blob, only the
  // persisted serve path.
  const savedScene: Scene = {
    ...scene,
    index: 2,
    assembledUrl: '/api/uploads/projects/p1/scenes/s1/assembled.mp4',
  }

  const renderSaved = () =>
    render(
      <SceneAssembleBar
        scene={savedScene}
        saving={false}
        onSave={async () => ''}
        onAssembleServer={async () => {}}
        onPreview={() => {}}
      />,
    )

  // jsdom has no object URLs; the blob-path test stubs them and must put them back.
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  beforeEach(() => {
    signAttachmentSpy.mockClear()
  })

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })

  it('points the download at the signed bucket URL, not the serve path', () => {
    renderSaved()
    const link = screen.getByRole('link', { name: /download/i })
    const href = link.getAttribute('href') ?? ''
    expect(href).toContain('bucket.example.com')
    expect(href).not.toMatch(/^\/api\/uploads\//)
  })

  it('signs the saved cut for attachment under the scene-numbered filename', () => {
    renderSaved()
    expect(signAttachmentSpy).toHaveBeenCalledWith({
      url: '/api/uploads/projects/p1/scenes/s1/assembled.mp4',
      filename: 'scene-3.mp4',
    })
  })

  it('names the download after the scene number', () => {
    renderSaved()
    const link = screen.getByRole('link', { name: /download/i })
    expect(link).toHaveAttribute('download', 'scene-3.mp4')
    const href = link.getAttribute('href') ?? ''
    const disposition = new URL(href).searchParams.get('response-content-disposition')
    expect(disposition).toBe('attachment; filename="scene-3.mp4"')
  })

  // The href is cross-origin, so the click is a real navigation. Without its own
  // browsing context it tears down every in-flight request on the page — the project
  // autosave died with NS_BINDING_ABORTED (see FinalCutBar). Losing `target` would
  // silently regress that.
  it('opens the cross-origin download in its own context so it cannot abort page requests', () => {
    renderSaved()
    const link = screen.getByRole('link', { name: /download/i })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener')
  })

  it('does not ask for a signature while there is nothing saved', () => {
    render(
      <SceneAssembleBar
        scene={scene}
        saving={false}
        onSave={async () => ''}
        onAssembleServer={async () => {}}
        onPreview={() => {}}
      />,
    )
    // Called with skipToken (a symbol), never with a { url, filename } body.
    for (const [arg] of signAttachmentSpy.mock.calls) {
      expect(typeof arg).toBe('symbol')
    }
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull()
  })

  it('keeps a fresh in-browser render on its same-origin blob: URL', async () => {
    // The blob path is same-origin by construction — the stub only makes it observable.
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/fresh-render')
    URL.revokeObjectURL = vi.fn()
    assembleSceneBlobMock.mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }))

    renderSaved()
    await act(async () => {
      screen.getByRole('button', { name: /re-assemble scene/i }).click()
    })

    const link = screen.getByRole('link', { name: /download/i })
    expect(link).toHaveAttribute('href', 'blob:http://localhost/fresh-render')
    expect(link).toHaveAttribute('download', 'scene-3.mp4')
  })
})
