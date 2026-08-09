/**
 * TDD for the ingest orchestrator (Task 6). Written first, against a hook that
 * doesn't exist yet — expected to fail on import until `useIngest.ts` lands.
 *
 * The whole api layer is mocked (`vi.mock`), per the brief: `../lib/upload`,
 * `../lib/audio`, `../lib/frames`, and `../store/videosApi`'s RTK hooks. That
 * keeps this a pure unit test of the ingest state machine — no Redux
 * `Provider`/store needed, since the mocked hooks stand in for the real RTK
 * Query ones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const {
  presignedUploadMock,
  sourceFileErrorMock,
  extractAudioMock,
  captureFrameSheetsMock,
  uploadFrameSheetsMock,
  saveVideoTrigger,
  transcribeStartTrigger,
  getJobTrigger,
} = vi.hoisted(() => ({
  presignedUploadMock: vi.fn(),
  sourceFileErrorMock: vi.fn(),
  extractAudioMock: vi.fn(),
  captureFrameSheetsMock: vi.fn(),
  uploadFrameSheetsMock: vi.fn(),
  saveVideoTrigger: vi.fn(),
  transcribeStartTrigger: vi.fn(),
  getJobTrigger: vi.fn(),
}))

vi.mock('../lib/upload', () => ({
  presignedUpload: presignedUploadMock,
  sourceFileError: sourceFileErrorMock,
}))

vi.mock('../lib/audio', () => ({
  extractAudio: extractAudioMock,
}))

vi.mock('../lib/frames', () => ({
  captureFrameSheets: captureFrameSheetsMock,
  uploadFrameSheets: uploadFrameSheetsMock,
}))

vi.mock('../store/videosApi', () => ({
  useSaveVideoMutation: () => [saveVideoTrigger, { isLoading: false }],
  useTranscribeStartMutation: () => [transcribeStartTrigger, { isLoading: false }],
  useLazyGetJobQuery: () => [getJobTrigger, { isFetching: false }],
}))

import { useIngest } from './useIngest'

/** Mimics an RTK Query trigger's return value: `{ unwrap: () => Promise<T> }`. */
function unwrap<T>(value: T) {
  return { unwrap: () => Promise.resolve(value) }
}

const FILE = new File(['bytes'], 'clip.mp4', { type: 'video/mp4' })

const PATHS_BY_BASE: Record<string, string> = {
  '/api/uploads/source': '/api/uploads/videos/v1/source/x.mp4',
  '/api/uploads/audio': '/api/uploads/videos/v1/audio/x.wav',
}

const SAMPLE_CAPTURE = {
  tileW: 320,
  tileH: 180,
  cols: 6,
  rows: 5,
  sheets: [{ blob: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }), tiles: [{ t: 5 }, { t: 15 }] }],
}

const SAMPLE_UPLOADED = {
  sheet_path: '/api/uploads/sheets/v1/sheet-0.jpg',
  sheet_meta: JSON.stringify({
    v: 2,
    tileW: 320,
    tileH: 180,
    cols: 6,
    rows: 5,
    sheets: [{ url: '/api/uploads/sheets/v1/sheet-0.jpg', tiles: [{ t: 5 }, { t: 15 }] }],
  }),
}

beforeEach(() => {
  vi.clearAllMocks()
  sourceFileErrorMock.mockReturnValue(null)
  presignedUploadMock.mockImplementation(async (_file: File, basePath: string) => PATHS_BY_BASE[basePath])
  saveVideoTrigger.mockImplementation((args: unknown) => unwrap({ video: args }))
  extractAudioMock.mockResolvedValue({ wav: new Blob(['wav-bytes']), durationSec: 42 })
  captureFrameSheetsMock.mockResolvedValue(SAMPLE_CAPTURE)
  uploadFrameSheetsMock.mockResolvedValue(SAMPLE_UPLOADED)
  transcribeStartTrigger.mockImplementation(() => unwrap({ jobId: 'job-1', status: 'pending' }))
})

describe('useIngest', () => {
  it('walks the happy path idle -> uploading -> extracting -> uploading-audio -> transcribing -> done', async () => {
    getJobTrigger
      .mockImplementationOnce(() =>
        unwrap({ status: 'pending', kind: 'transcribe', result: null, error: null }),
      )
      .mockImplementationOnce(() =>
        unwrap({ status: 'done', kind: 'transcribe', result: { words: [], text: 'hi' }, error: null }),
      )

    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useIngest('v1'))
      expect(result.current.stage).toBe('idle')

      let startPromise!: Promise<void>
      act(() => {
        startPromise = result.current.start(FILE)
      })

      // Flush the upload -> frames -> extract -> upload-audio -> transcribeStart
      // chain (all resolved microtasks, no real timers involved) up to the
      // first poll.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(sourceFileErrorMock).toHaveBeenCalledWith(FILE)
      // Only source + audio go through presignedUpload directly — the sheet
      // upload is entirely inside the (mocked) uploadFrameSheets.
      expect(presignedUploadMock).toHaveBeenCalledTimes(2)
      expect(presignedUploadMock.mock.calls[0][1]).toBe('/api/uploads/source')
      expect(presignedUploadMock.mock.calls[1][1]).toBe('/api/uploads/audio')
      expect(captureFrameSheetsMock).toHaveBeenCalledWith(FILE)
      expect(uploadFrameSheetsMock).toHaveBeenCalledWith(SAMPLE_CAPTURE, 'v1')
      expect(saveVideoTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: 'v1', source_path: '/api/uploads/videos/v1/source/x.mp4' }),
      )
      expect(saveVideoTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          videoId: 'v1',
          sheet_path: SAMPLE_UPLOADED.sheet_path,
          sheet_meta: SAMPLE_UPLOADED.sheet_meta,
        }),
      )
      expect(saveVideoTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: 'v1', audio_path: '/api/uploads/videos/v1/audio/x.wav' }),
      )
      expect(transcribeStartTrigger).toHaveBeenCalledWith({
        videoId: 'v1',
        audioPath: '/api/uploads/videos/v1/audio/x.wav',
        durationSec: 42,
      })
      expect(result.current.stage).toBe('transcribing')
      expect(result.current.progress.durationSec).toBe(42)
      expect(getJobTrigger).toHaveBeenCalledTimes(1)

      // Second poll, 2s later, comes back done.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      await act(async () => {
        await startPromise
      })

      expect(getJobTrigger).toHaveBeenCalledTimes(2)
      expect(result.current.stage).toBe('done')
      expect(result.current.error).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a non-video file before any upload starts', async () => {
    sourceFileErrorMock.mockReturnValue('That doesn’t look like a video file.')
    const { result } = renderHook(() => useIngest('v1'))

    await act(async () => {
      await result.current.start(FILE)
    })

    expect(result.current.stage).toBe('error')
    expect(result.current.error).toMatch(/video file/)
    expect(presignedUploadMock).not.toHaveBeenCalled()
  })

  it('surfaces a poll error and retryTranscribe re-enqueues to done', async () => {
    getJobTrigger.mockImplementationOnce(() =>
      unwrap({ status: 'error', kind: 'transcribe', result: null, error: 'boom' }),
    )

    const { result } = renderHook(() => useIngest('v1'))

    await act(async () => {
      await result.current.start(FILE)
    })

    expect(result.current.stage).toBe('error')
    expect(result.current.error).toBe('boom')
    expect(transcribeStartTrigger).toHaveBeenCalledTimes(1)

    // Retry re-enqueues from the ALREADY-uploaded audio — no re-upload.
    transcribeStartTrigger.mockImplementationOnce(() => unwrap({ jobId: 'job-2', status: 'pending' }))
    getJobTrigger.mockImplementationOnce(() =>
      unwrap({ status: 'done', kind: 'transcribe', result: { words: [], text: 'hi' }, error: null }),
    )

    await act(async () => {
      await result.current.retryTranscribe()
    })

    expect(presignedUploadMock).toHaveBeenCalledTimes(2) // still just the original upload (source + audio)
    expect(transcribeStartTrigger).toHaveBeenCalledTimes(2)
    expect(transcribeStartTrigger).toHaveBeenLastCalledWith({
      videoId: 'v1',
      audioPath: '/api/uploads/videos/v1/audio/x.wav',
      durationSec: 42,
    })
    expect(result.current.stage).toBe('done')
    expect(result.current.error).toBeNull()
  })

  it('skips the sheet upload (but keeps going) when frame capture yields no sheets', async () => {
    captureFrameSheetsMock.mockResolvedValue({ tileW: 320, tileH: 180, cols: 6, rows: 5, sheets: [] })
    getJobTrigger.mockImplementationOnce(() =>
      unwrap({ status: 'done', kind: 'transcribe', result: { words: [], text: 'hi' }, error: null }),
    )

    const { result } = renderHook(() => useIngest('v1'))
    await act(async () => {
      await result.current.start(FILE)
    })

    expect(captureFrameSheetsMock).toHaveBeenCalledWith(FILE)
    expect(uploadFrameSheetsMock).not.toHaveBeenCalled()
    // Only source + audio uploaded — no sheet upload/save for an empty capture.
    expect(presignedUploadMock).toHaveBeenCalledTimes(2)
    expect(presignedUploadMock.mock.calls.map((c) => c[1])).toEqual([
      '/api/uploads/source',
      '/api/uploads/audio',
    ])
    expect(saveVideoTrigger).not.toHaveBeenCalledWith(expect.objectContaining({ sheet_path: expect.anything() }))
    expect(result.current.stage).toBe('done')
  })

  it('skips saving when captured sheets exist but every upload fails (uploadFrameSheets returns null)', async () => {
    uploadFrameSheetsMock.mockResolvedValue(null)
    getJobTrigger.mockImplementationOnce(() =>
      unwrap({ status: 'done', kind: 'transcribe', result: { words: [], text: 'hi' }, error: null }),
    )

    const { result } = renderHook(() => useIngest('v1'))
    await act(async () => {
      await result.current.start(FILE)
    })

    expect(uploadFrameSheetsMock).toHaveBeenCalled()
    expect(saveVideoTrigger).not.toHaveBeenCalledWith(expect.objectContaining({ sheet_path: expect.anything() }))
    expect(result.current.stage).toBe('done')
  })

  it('retryTranscribe is a no-op error if nothing has been uploaded yet', async () => {
    const { result } = renderHook(() => useIngest('v1'))

    await act(async () => {
      await result.current.retryTranscribe()
    })

    expect(result.current.stage).toBe('error')
    expect(transcribeStartTrigger).not.toHaveBeenCalled()
  })
})
