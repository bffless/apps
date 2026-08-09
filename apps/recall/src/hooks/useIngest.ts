/**
 * Ingest orchestrator (Task 6): drive one video from a picked file through
 * upload -> frames -> extract -> upload-audio -> transcribe, sequentially, in
 * the browser. Mirrors Studio's `useScenePipeline` fire-and-poll pattern (a
 * sequential await chain + a 2s poll loop against a job row) reduced to
 * Recall's single-stage shape — there's no scene queue here, just one video.
 *
 * The `frames` stage (PR-feedback-2) cuts + uploads a contact-sheet sprite
 * from the just-uploaded local `File` (cheapest source — no signed-URL round
 * trip needed) right after the source upload lands. `captureFrameSheet`
 * itself never throws (see `lib/frames.ts`) — a stalled/broken capture
 * resolves with no tiles, which this stage treats as "skip it" rather than
 * failing the whole pipeline over a thumbnail: uploading and transcribing the
 * video are the parts that actually matter.
 *
 * State lives entirely in this hook (component-local), not Redux: it's
 * transient UI progress, not durable business state — the durable bits
 * (`source_path`, `audio_path`, `status`, `transcript`) are written straight
 * onto the `recall_videos` record by `saveVideo` and by the transcribe rule
 * itself, so a reload always has ground truth in the record, not here (see
 * `AdminVideo.tsx`, which reads `video.status` separately to show an
 * indeterminate "transcribing…" note across reloads — this hook does NOT try
 * to resume a poll for a job it doesn't know the id of).
 */

import { useCallback, useRef, useState } from 'react'
import { extractAudio } from '../lib/audio'
import { captureFrameSheet } from '../lib/frames'
import { presignedUpload, sourceFileError } from '../lib/upload'
import { useLazyGetJobQuery, useSaveVideoMutation, useTranscribeStartMutation } from '../store/videosApi'

export type IngestStage =
  | 'idle'
  | 'uploading'
  | 'frames'
  | 'extracting'
  | 'uploading-audio'
  | 'transcribing'
  | 'done'
  | 'error'

export type IngestProgress = { durationSec: number | null }

const POLL_INTERVAL_MS = 2000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

export function useIngest(videoId: string) {
  const [stage, setStage] = useState<IngestStage>('idle')
  const [progress, setProgress] = useState<IngestProgress>({ durationSec: null })
  const [error, setError] = useState<string | null>(null)

  const [saveVideo] = useSaveVideoMutation()
  const [transcribeStart] = useTranscribeStartMutation()
  const [triggerGetJob] = useLazyGetJobQuery()

  // Set once the audio upload lands, so `retryTranscribe` can re-enqueue the
  // SAME already-uploaded audio without re-running the upload/extract steps.
  // `canRetry` mirrors the ref into render state so the UI can tell whether
  // "Retry" means "re-enqueue" (audio already up) or "start over" (it isn't).
  const audioInfoRef = useRef<{ audioPath: string; durationSec: number } | null>(null)
  const [canRetry, setCanRetry] = useState(false)

  /** Poll `getJob` every 2s until it reaches a terminal status, or throw. */
  const pollUntilTerminal = useCallback(
    async (jobId: string): Promise<void> => {
      for (;;) {
        const job = await triggerGetJob(jobId).unwrap()
        if (job.status === 'done') return
        if (job.status === 'error') throw new Error(job.error || 'Transcription failed.')
        await delay(POLL_INTERVAL_MS)
      }
    },
    [triggerGetJob],
  )

  /** ENQUEUE `/api/transcribe` for the given (already-uploaded) audio, then poll it home. */
  const enqueueTranscribe = useCallback(
    async (audioPath: string, durationSec: number): Promise<void> => {
      setStage('transcribing')
      setError(null)
      const { jobId } = await transcribeStart({ videoId, audioPath, durationSec }).unwrap()
      await pollUntilTerminal(jobId)
      setStage('done')
    },
    [videoId, transcribeStart, pollUntilTerminal],
  )

  /**
   * Validate, then run the full staged pipeline: upload the source video,
   * extract its audio locally, upload the audio, persist both paths on the
   * video record as each lands, then enqueue + poll the transcribe job.
   */
  const start = useCallback(
    async (file: File): Promise<void> => {
      setError(null)

      const validationError = sourceFileError(file)
      if (validationError) {
        setStage('error')
        setError(validationError)
        return
      }

      try {
        setStage('uploading')
        const sourcePath = await presignedUpload(file, '/api/uploads/source', videoId)
        await saveVideo({ videoId, source_path: sourcePath }).unwrap()

        setStage('frames')
        const sheet = await captureFrameSheet(file)
        if (sheet.blob && sheet.meta.tiles.length > 0) {
          const sheetFile = new File([sheet.blob], 'sheet.jpg', { type: 'image/jpeg' })
          const sheetPath = await presignedUpload(sheetFile, '/api/uploads/sheet', videoId)
          await saveVideo({ videoId, sheet_path: sheetPath, sheet_meta: JSON.stringify(sheet.meta) }).unwrap()
        }

        setStage('extracting')
        const { wav, durationSec } = await extractAudio(file)
        setProgress({ durationSec })

        setStage('uploading-audio')
        const audioFile = new File([wav], 'audio.wav', { type: 'audio/wav' })
        const audioPath = await presignedUpload(audioFile, '/api/uploads/audio', videoId)
        await saveVideo({ videoId, audio_path: audioPath }).unwrap()
        audioInfoRef.current = { audioPath, durationSec }
        setCanRetry(true)

        await enqueueTranscribe(audioPath, durationSec)
      } catch (e) {
        setStage('error')
        setError(errorMessage(e, 'Something went wrong during ingest.'))
      }
    },
    [videoId, saveVideo, enqueueTranscribe],
  )

  /** Re-enqueue transcription for the already-uploaded audio (no re-upload). */
  const retryTranscribe = useCallback(async (): Promise<void> => {
    const info = audioInfoRef.current
    if (!info) {
      setStage('error')
      setError('Nothing to retry yet — upload a video first.')
      return
    }
    try {
      await enqueueTranscribe(info.audioPath, info.durationSec)
    } catch (e) {
      setStage('error')
      setError(errorMessage(e, 'Transcription failed again.'))
    }
  }, [enqueueTranscribe])

  return { stage, progress, error, start, retryTranscribe, canRetry }
}
