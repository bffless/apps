/**
 * Drives POST /api/index -> poll /api/recall/job to a terminal state (Task 8).
 * Mirrors `useIngest`'s enqueue+poll shape (see `enqueueTranscribe` /
 * `pollUntilTerminal` there) reduced to a single stage: there's no staged
 * upload pipeline for indexing, just "start, then wait for it to land".
 *
 * The rule can also reject synchronously with a 400 `{ error: reason }` body
 * (the video isn't eligible yet -- wrong status, no youtube_url, no
 * transcript) before any job is even created; `errorMessage` surfaces that
 * `reason` the same way a terminal job error is surfaced, so the caller
 * doesn't need to special-case "rejected before enqueue" vs "failed after
 * enqueue".
 */

import { useCallback, useState } from 'react'
import { useIndexStartMutation, useLazyGetJobQuery } from '../store/videosApi'

export type IndexStage = 'idle' | 'indexing' | 'done' | 'error'

const POLL_INTERVAL_MS = 2000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'data' in e) {
    const data = (e as { data?: unknown }).data
    if (data && typeof data === 'object' && 'error' in data) {
      const reason = (data as { error?: unknown }).error
      if (typeof reason === 'string' && reason) return reason
    }
  }
  return e instanceof Error && e.message ? e.message : fallback
}

export function useIndexJob(videoId: string) {
  const [stage, setStage] = useState<IndexStage>('idle')
  const [error, setError] = useState<string | null>(null)

  const [indexStart] = useIndexStartMutation()
  const [triggerGetJob] = useLazyGetJobQuery()

  const start = useCallback(async (): Promise<void> => {
    setStage('indexing')
    setError(null)
    try {
      const { jobId } = await indexStart({ videoId }).unwrap()
      for (;;) {
        const job = await triggerGetJob(jobId).unwrap()
        if (job.status === 'done') {
          setStage('done')
          return
        }
        if (job.status === 'error') {
          throw new Error(job.error || 'Indexing failed.')
        }
        await delay(POLL_INTERVAL_MS)
      }
    } catch (e) {
      setStage('error')
      setError(errorMessage(e, 'Something went wrong while indexing.'))
    }
  }, [videoId, indexStart, triggerGetJob])

  return { stage, error, start }
}
