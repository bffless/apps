/**
 * ImagePinLayer: the click-to-drop-a-pin overlay for image handoffs.
 *
 * Two coordinate systems meet here. `pins` carry fractions of the image's
 * *natural* size (0..1) — the same fractions `CommentAnchorPin` stores — but
 * the overlay has to sit over the *rendered* box. An `object-contain` image
 * centered in its element box letterboxes whenever its aspect ratio doesn't
 * match the box's, so the rendered rect is smaller than (and offset within)
 * the element. `renderedImageRect` is that pure letterbox math, exported so
 * Task 12 (and this file's own tests) can reason about it without a real
 * browser layout engine.
 *
 * The component itself just measures the img's own box (`offsetWidth` /
 * `offsetHeight`) and natural size on mount, on the img's `load` event, and
 * via ResizeObserver — guarded because jsdom has none — and turns that into
 * the overlay div's inline position. The overlay is sized/positioned to
 * exactly that rect, so a background click's `clientX/Y` minus the overlay's
 * own `getBoundingClientRect()` is already in rendered-image space; dividing
 * by the rect's width/height converts it to the same 0..1 fractions the pins
 * use.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CommentAnchorPin } from '../../lib/comments'

export interface ImagePinLayerProps {
  imgRef: React.RefObject<HTMLImageElement | null>
  pins: { id: string; pin: CommentAnchorPin; n: number }[]
  activeId: string | null
  canWrite: boolean
  onActivate: (id: string) => void
  onPlacePin: (pin: CommentAnchorPin) => void
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

const EMPTY_RECT: Rect = { left: 0, top: 0, width: 0, height: 0 }

/**
 * Letterbox math for an `object-contain` image centered in `box`. Returns the
 * rendered rect (in `box`-local coordinates). Degenerate for a zero/invalid
 * box or natural size — never NaN.
 */
// Pure helper deliberately co-located with the component per the Task 11
// binding contract (Task 12 imports both from this module).
// eslint-disable-next-line react-refresh/only-export-components
export function renderedImageRect(
  box: { width: number; height: number },
  natural: { width: number; height: number },
): Rect {
  if (
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    !Number.isFinite(natural.width) ||
    !Number.isFinite(natural.height) ||
    box.width <= 0 ||
    box.height <= 0 ||
    natural.width <= 0 ||
    natural.height <= 0
  ) {
    return EMPTY_RECT
  }

  const scale = Math.min(box.width / natural.width, box.height / natural.height)
  const width = natural.width * scale
  const height = natural.height * scale
  return {
    left: (box.width - width) / 2,
    top: (box.height - height) / 2,
    width,
    height,
  }
}

export function ImagePinLayer({
  imgRef,
  pins,
  activeId,
  canWrite,
  onActivate,
  onPlacePin,
}: ImagePinLayerProps) {
  const [rect, setRect] = useState<Rect>(EMPTY_RECT)

  const measure = useCallback(() => {
    const img = imgRef.current
    if (!img) {
      setRect(EMPTY_RECT)
      return
    }
    setRect(
      renderedImageRect(
        { width: img.offsetWidth, height: img.offsetHeight },
        { width: img.naturalWidth, height: img.naturalHeight },
      ),
    )
  }, [imgRef])

  useEffect(() => {
    measure()
    const img = imgRef.current
    if (!img) return
    img.addEventListener('load', measure)
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(img)
    }
    return () => {
      img.removeEventListener('load', measure)
      observer?.disconnect()
    }
  }, [imgRef, measure])

  function handleBackgroundClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!canWrite || e.target !== e.currentTarget) return
    const box = e.currentTarget.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
    const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height))
    onPlacePin({ type: 'pin', x, y })
  }

  return (
    <div
      data-testid="image-pin-overlay"
      className="absolute"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onClick={handleBackgroundClick}
    >
      {pins.map(({ id, pin, n }) => {
        const active = activeId === id
        return (
          <button
            key={id}
            type="button"
            data-testid={`image-pin-dot-${id}`}
            aria-label={`Comment ${n}`}
            aria-pressed={active}
            onClick={(e) => {
              e.stopPropagation()
              onActivate(id)
            }}
            style={{ left: pin.x * rect.width, top: pin.y * rect.height }}
            className={[
              'absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-600 text-white text-xs font-semibold flex h-6 w-6 items-center justify-center shadow ring-2 ring-white cursor-pointer',
              active ? 'scale-110 ring-accent-600' : '',
            ].join(' ')}
          >
            {n}
          </button>
        )
      })}
    </div>
  )
}
