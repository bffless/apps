/**
 * ImagePinLayer: the click-to-drop-a-pin overlay for image handoffs (Task 11).
 *
 * `renderedImageRect` is pure letterbox math — tested directly, no DOM. The
 * component tests mount a real `<img>` and fake the two properties jsdom
 * never lays out (`naturalWidth/Height`, `offsetWidth/Height`) to stand in
 * for a 200×100 image rendered `object-contain` inside a 400×400 box, which
 * letterboxes to a 400×200 rect at `top: 100`. Background-click tests also
 * fake the overlay's own `getBoundingClientRect()` to match that rect, since
 * jsdom doesn't compute real layout either.
 */
import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ImagePinLayer, renderedImageRect } from './ImagePinLayer'
import type { ImagePinLayerProps } from './ImagePinLayer'

describe('renderedImageRect', () => {
  it('letterboxes top/bottom for a wide image in a tall box', () => {
    expect(renderedImageRect({ width: 400, height: 400 }, { width: 200, height: 100 })).toEqual({
      left: 0,
      top: 100,
      width: 400,
      height: 200,
    })
  })

  it('letterboxes left/right for a tall image in a wide box', () => {
    expect(renderedImageRect({ width: 400, height: 400 }, { width: 100, height: 200 })).toEqual({
      left: 100,
      top: 0,
      width: 200,
      height: 400,
    })
  })

  it('fills the box exactly when the aspect ratio matches', () => {
    expect(renderedImageRect({ width: 300, height: 200 }, { width: 150, height: 100 })).toEqual({
      left: 0,
      top: 0,
      width: 300,
      height: 200,
    })
  })

  it('returns a degenerate rect without NaN for a zero/invalid natural size', () => {
    expect(renderedImageRect({ width: 400, height: 400 }, { width: 0, height: 0 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    })
    expect(renderedImageRect({ width: 400, height: 400 }, { width: -1, height: 100 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    })
  })

  it('returns a degenerate rect without NaN for a zero box', () => {
    expect(renderedImageRect({ width: 0, height: 0 }, { width: 200, height: 100 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    })
  })
})

describe('ImagePinLayer', () => {
  /** Renders a `<img>` + `ImagePinLayer` pair standing in for a 200×100
   *  image `object-contain` inside a 400×400 box, and fires `load` so the
   *  layer picks up the faked measurements. */
  function renderLayer(props: Partial<ImagePinLayerProps> = {}) {
    const imgRef = createRef<HTMLImageElement>()
    const utils = render(
      <div style={{ position: 'relative' }}>
        <img ref={imgRef} alt="" />
        <ImagePinLayer
          imgRef={imgRef}
          pins={[]}
          activeId={null}
          canWrite={true}
          onActivate={() => {}}
          onPlacePin={() => {}}
          {...props}
        />
      </div>,
    )
    const img = imgRef.current
    if (!img) throw new Error('img did not mount')
    Object.defineProperty(img, 'naturalWidth', { value: 200, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: 100, configurable: true })
    Object.defineProperty(img, 'offsetWidth', { value: 400, configurable: true })
    Object.defineProperty(img, 'offsetHeight', { value: 400, configurable: true })
    fireEvent.load(img)
    return { ...utils, imgRef }
  }

  it('sizes the overlay to the letterboxed rect and centers a dot at its fraction', () => {
    renderLayer({ pins: [{ id: 'c1', pin: { type: 'pin', x: 0.5, y: 0.5 }, n: 1 }] })

    const overlay = screen.getByTestId('image-pin-overlay')
    expect(overlay).toHaveStyle({ left: '0px', top: '100px', width: '400px', height: '200px' })

    // Local to the overlay itself, which sits at (0, 100) within the 400×400
    // box: 0.5 * 400 = 200, 0.5 * 200 = 100 — i.e. the dot's absolute center
    // is (200, 100 + 100) = (200, 200), the pin centered in the 400×400 box.
    const dot = screen.getByTestId('image-pin-dot-c1')
    expect(dot).toHaveStyle({ left: '200px', top: '100px' })
    expect(dot).toHaveTextContent('1')
  })

  it('converts a background click to fractional coords and calls onPlacePin when canWrite', () => {
    const onPlacePin = vi.fn()
    renderLayer({ onPlacePin })

    const overlay = screen.getByTestId('image-pin-overlay')
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 100, width: 400, height: 200 }) as DOMRect
    fireEvent.click(overlay, { clientX: 100, clientY: 200 })

    expect(onPlacePin).toHaveBeenCalledWith({ type: 'pin', x: 0.25, y: 0.5 })
  })

  it('does nothing on a background click when canWrite is false', () => {
    const onPlacePin = vi.fn()
    renderLayer({ canWrite: false, onPlacePin })

    const overlay = screen.getByTestId('image-pin-overlay')
    overlay.getBoundingClientRect = () =>
      ({ left: 0, top: 100, width: 400, height: 200 }) as DOMRect
    fireEvent.click(overlay, { clientX: 100, clientY: 200 })

    expect(onPlacePin).not.toHaveBeenCalled()
  })

  it('calls onActivate when a dot is clicked, without also placing a pin', () => {
    const onActivate = vi.fn()
    const onPlacePin = vi.fn()
    renderLayer({
      pins: [{ id: 'c1', pin: { type: 'pin', x: 0.5, y: 0.5 }, n: 1 }],
      onActivate,
      onPlacePin,
    })

    fireEvent.click(screen.getByTestId('image-pin-dot-c1'))

    expect(onActivate).toHaveBeenCalledWith('c1')
    expect(onPlacePin).not.toHaveBeenCalled()
  })

  it('emphasizes the active pin', () => {
    renderLayer({
      pins: [{ id: 'c1', pin: { type: 'pin', x: 0.5, y: 0.5 }, n: 1 }],
      activeId: 'c1',
    })

    expect(screen.getByTestId('image-pin-dot-c1').className).toMatch(/scale-110/)
    expect(screen.getByTestId('image-pin-dot-c1').className).toMatch(/ring-accent-600/)
  })
})
