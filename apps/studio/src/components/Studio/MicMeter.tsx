import { useEffect, useRef } from 'react'

type Props = {
  /** Live mic stream to visualize; null when not recording. */
  stream: MediaStream | null
  height?: number
}

/**
 * The "it hears you" feedback while recording: a live bar meter driven straight
 * off the mic via a WebAudio `AnalyserNode`. Like `Waveform`, it draws to a
 * canvas inside a `requestAnimationFrame` loop writing through refs — no React
 * state per frame — so it stays clear of the strict `react-hooks` rules. The
 * analyser + audio context are torn down whenever the stream changes or the
 * component unmounts.
 */
export function MicMeter({ stream, height = 56 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !stream) return

    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const audioCtx = new Ctx()
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)

    let raf = 0
    const BARS = 48
    const draw = () => {
      analyser.getByteFrequencyData(data)
      const w = wrap.clientWidth
      const dpr = window.devicePixelRatio || 1
      canvas.width = w * dpr
      canvas.height = height * dpr
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.scale(dpr, dpr)
        ctx.clearRect(0, 0, w, height)
        const mid = height / 2
        const gap = 2
        const barW = Math.max(1, w / BARS - gap)
        const per = Math.floor(data.length / BARS) || 1
        for (let i = 0; i < BARS; i++) {
          // Average a slice of the spectrum into one bar; emphasize a little.
          let sum = 0
          for (let j = 0; j < per; j++) sum += data[i * per + j] ?? 0
          const level = sum / per / 255
          const half = Math.max(0.5, level * (mid - 1) * 1.6)
          const x = i * (barW + gap)
          ctx.fillStyle = 'rgba(216, 90, 61, 0.85)' // terracotta
          ctx.fillRect(x, mid - half, barW, half * 2)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      source.disconnect()
      void audioCtx.close()
    }
  }, [stream, height])

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  )
}
