/**
 * SceneAssembleBar — what the card says about a scene that rendered but did NOT save.
 *
 * The failure that opened issue #220: the producer assembled a scene by hand to fix
 * a halted auto-build, the upload failed, and the card still looked like a saved
 * scene (a video preview, a working Download link). They moved on believing it was
 * saved. A rendered-but-unsaved scene must never read as a saved one.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'

// Component tests mock the studioApi module directly — no Redux Provider / MSW
// (matches FinalCutBar.test.tsx / SourceQueue.test.tsx).
vi.mock('../../store/studioApi', () => ({
  useSignDownloadQuery: () => ({ data: undefined }),
  useLazySignDownloadQuery: () => [vi.fn()],
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
