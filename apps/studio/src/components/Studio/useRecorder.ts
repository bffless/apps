import { useCallback, useEffect, useRef, useState } from 'react'

export type RecorderStatus = 'idle' | 'recording' | 'recorded'

export type Recorder = {
  status: RecorderStatus
  /** Seconds elapsed in the current/last take. */
  elapsed: number
  /** The finished recording, once stopped. */
  blob: Blob | null
  /** Object URL for playing the take back; null until recorded. */
  url: string | null
  /** Live mic stream while recording — feed it to the level meter. */
  stream: MediaStream | null
  /** getUserMedia / MediaRecorder error message, if any. */
  error: string | null
  start: () => Promise<void>
  stop: () => void
  /** Discard the take and return to idle (revokes the object URL). */
  reset: () => void
}

/** Pick a mic mime type the browser actually supports (Safari ≠ Chrome). */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  return candidates.find((t) => MediaRecorder.isTypeSupported(t))
}

/**
 * A small `MediaRecorder` wrapper for the voice-clone sample: grab the mic,
 * record, and hand back a Blob + playback URL. All state changes happen in event
 * callbacks (start/stop handlers, recorder events, the elapsed-time interval) —
 * never in an effect — so it stays clear of the strict `react-hooks` lint rules.
 * The only effect is teardown on unmount: stop the stream and revoke the URL.
 */
export function useRecorder(): Recorder {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const timerRef = useRef<number | null>(null)
  const urlRef = useRef<string | null>(null)

  const stopTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const stopStream = useCallback((s: MediaStream | null) => {
    s?.getTracks().forEach((t) => t.stop())
  }, [])

  const start = useCallback(async () => {
    setError(null)
    // Drop any previous take before starting a fresh one.
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setBlob(null)
    setUrl(null)
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickMimeType()
      const rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm'
        const finished = new Blob(chunksRef.current, { type })
        const objectUrl = URL.createObjectURL(finished)
        urlRef.current = objectUrl
        setBlob(finished)
        setUrl(objectUrl)
        setStatus('recorded')
        stopTimer()
        stopStream(media)
        setStream(null)
      }
      recorderRef.current = rec
      setStream(media)
      setElapsed(0)
      rec.start()
      setStatus('recording')
      const startedAt = performance.now()
      timerRef.current = window.setInterval(() => {
        setElapsed((performance.now() - startedAt) / 1000)
      }, 200)
    } catch (e) {
      setError(
        e instanceof Error
          ? e.name === 'NotAllowedError'
            ? 'Microphone access was denied.'
            : e.message
          : 'Could not access the microphone.',
      )
      setStatus('idle')
    }
  }, [stopTimer, stopStream])

  const stop = useCallback(() => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
  }, [])

  const reset = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setBlob(null)
    setUrl(null)
    setElapsed(0)
    setStatus('idle')
  }, [])

  // Teardown only — stop the mic and revoke the URL if the component unmounts
  // mid-take. No state writes here, so it stays out of the lint rules' way.
  useEffect(() => {
    return () => {
      stopTimer()
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop()
      }
      stopStream(recorderRef.current?.stream ?? null)
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [stopTimer, stopStream])

  return { status, elapsed, blob, url, stream, error, start, stop, reset }
}
