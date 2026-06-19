import { useEffect, useState } from 'react'
import { captureFrames } from '../../lib/frames'

type Props = {
  src: string
  duration: number
  /** How many frames to sample across the clip. */
  count?: number
  height?: number
  /** Pre-captured frames; if given, skips its own capture. */
  frames?: string[]
}

/** The "iMovie filmstrip" — evenly sampled frames drawn from the clip. */
export function Filmstrip({ src, duration, count = 12, height = 48, frames }: Props) {
  const [own, setOwn] = useState<string[]>([])
  const provided = frames !== undefined

  useEffect(() => {
    if (provided) return
    let cancelled = false
    captureFrames(src, duration, count, height).then((f) => {
      if (!cancelled) setOwn(f)
    })
    return () => {
      cancelled = true
    }
  }, [src, duration, count, height, provided])

  const shown = provided ? frames : own

  return (
    <div className="flex w-full overflow-hidden" style={{ height }}>
      {shown.length === 0
        ? Array.from({ length: count }).map((_, i) => (
            <div key={i} className="h-full flex-1 border-r border-paper/40 bg-ink/10" />
          ))
        : shown.map((f, i) => (
            <img
              key={i}
              src={f}
              alt=""
              draggable={false}
              className="h-full flex-1 border-r border-paper/30 object-cover last:border-r-0"
            />
          ))}
    </div>
  )
}
