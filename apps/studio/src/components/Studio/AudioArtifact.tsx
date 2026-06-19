import { useEffect, useRef, useState } from 'react'
import { peaksFromUrl } from '../../lib/audio'
import { Waveform } from './Waveform'

type Props = {
  /** Compact waveform peaks of the extracted audio (from `computePeaks`). */
  peaks: number[]
  /** Serve path of the uploaded WAV — what the `<audio>` element plays. */
  audioUrl: string
}

/**
 * The "we extracted the audio" resource: a stenograph of the extracted track
 * under the video, plus a plain player to hear *just* the audio on its own.
 * The waveform is drawn from the persisted peaks (no re-decode), and the
 * playhead lights up the bars as the audio plays.
 */
export function AudioArtifact({ peaks, audioUrl }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [progress, setProgress] = useState(0)
  // Sessions extracted before peaks were persisted arrive with an empty array —
  // derive the waveform from the uploaded WAV in that case (decoded once).
  const [derived, setDerived] = useState<number[] | null>(null)
  useEffect(() => {
    if (peaks.length > 0) return
    let cancelled = false
    peaksFromUrl(audioUrl)
      .then((p) => !cancelled && setDerived(p))
      .catch(() => !cancelled && setDerived([]))
    return () => {
      cancelled = true
    }
  }, [peaks.length, audioUrl])
  const shown = peaks.length > 0 ? peaks : derived
  const loading = shown === null

  function onTime() {
    const a = audioRef.current
    if (a && a.duration) setProgress(a.currentTime / a.duration)
  }

  return (
    <div className="border rule bg-paper p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="meta-label">Extracted audio</p>
        <p className="font-mono text-[11px] text-ink-faint">16 kHz mono · play it back</p>
      </div>

      {/* click anywhere on the waveform to seek */}
      <button
        type="button"
        className="block w-full cursor-pointer"
        aria-label="Seek audio"
        onClick={(e) => {
          const a = audioRef.current
          if (!a || !a.duration) return
          const rect = e.currentTarget.getBoundingClientRect()
          a.currentTime = ((e.clientX - rect.left) / rect.width) * a.duration
        }}
      >
        {loading ? (
          <div className="flex h-14 items-center justify-center text-[12px] text-ink-mute">
            Reading audio…
          </div>
        ) : (
          <Waveform peaks={shown} progress={progress} />
        )}
      </button>

      <audio
        ref={audioRef}
        src={audioUrl}
        controls
        className="mt-3 h-9 w-full"
        onTimeUpdate={onTime}
        onEnded={() => setProgress(0)}
      />
    </div>
  )
}
