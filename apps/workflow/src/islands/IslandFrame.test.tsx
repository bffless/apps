/**
 * `IslandFrame` — the React half of the island host: one sandboxed iframe, and
 * the mount/teardown lifecycle around it. The host itself is faked here (its
 * own suite drives the real protocol); what this suite proves is the frame's
 * contract with React — the sandbox attributes, and that a StrictMode
 * double-mount never leaves two live bridges.
 */
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { IslandFrame } from './IslandFrame'
import type { IslandHost } from './IslandHost'
import { IslandLoadError } from './IslandHost'

interface FakeHost extends IslandHost {
  mounts: number
  teardowns: string[]
  live: number
  peak: number
  modes: string[]
  /** Every `sendToolInput` after the mount, in order. */
  inputs: Record<string, unknown>[]
}

function fakeHost(mount?: IslandHost['mount']): FakeHost {
  const host: FakeHost = {
    mounts: 0,
    teardowns: [],
    live: 0,
    peak: 0,
    modes: [],
    inputs: [],
    async mount(iframe, a) {
      host.mounts += 1
      host.live += 1
      host.peak = Math.max(host.peak, host.live)
      if (mount) await mount(iframe, a)
      else await Promise.resolve()
    },
    setDisplayMode(mode) {
      host.modes.push(mode)
    },
    setHeadless() {},
    async sendToolInput(args) {
      host.inputs.push(args)
    },
    async teardown(reason) {
      host.teardowns.push(reason)
      if (host.live > 0) host.live -= 1
    },
  }
  return host
}

const PROPS = {
  impl: 'hello',
  src: 'islands/editor.html',
  arguments: { lines: ['a'] },
  headless: false,
  display: 'inline' as const,
  onLoadError: () => {},
}

describe('IslandFrame', () => {
  it('renders a script-only sandboxed iframe titled after the step', () => {
    render(<IslandFrame {...PROPS} host={fakeHost()} title="Cut editor" />)

    const frame = screen.getByTestId('island-frame')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame).toHaveAttribute('title', 'Cut editor')
  })

  it('falls back to the src as the frame title and builds the allow attribute from permissions', () => {
    render(<IslandFrame {...PROPS} host={fakeHost()} permissions={{ microphone: {} }} />)

    const frame = screen.getByTestId('island-frame')
    expect(frame).toHaveAttribute('title', 'islands/editor.html')
    expect(frame).toHaveAttribute('allow', 'microphone')
  })

  it('mounts the island on the real frame element and tears it down on unmount', async () => {
    const host = fakeHost()
    const { unmount } = render(<IslandFrame {...PROPS} host={host} />)

    await waitFor(() => expect(host.mounts).toBe(1))
    unmount()
    await waitFor(() => expect(host.teardowns).toEqual(['unmounted']))
  })

  it('never runs two mounts at once under a StrictMode double-mount', async () => {
    const host = fakeHost(() => new Promise((resolve) => setTimeout(resolve, 5)))

    render(
      <StrictMode>
        <IslandFrame {...PROPS} host={host} />
      </StrictMode>,
    )

    await waitFor(() => expect(host.mounts).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.peak).toBe(1)
  })

  it('pushes the page\'s display mode down to the host when the prop changes', async () => {
    const host = fakeHost()
    const { rerender } = render(<IslandFrame {...PROPS} host={host} />)

    await waitFor(() => expect(host.mounts).toBe(1))
    expect(host.modes).toEqual(['inline', 'inline'])

    rerender(<IslandFrame {...PROPS} host={host} display="fullscreen" />)
    expect(host.modes.at(-1)).toBe('fullscreen')

    rerender(<IslandFrame {...PROPS} host={host} display="inline" />)
    expect(host.modes.at(-1)).toBe('inline')
  })

  it('reports an ISLAND_LOAD rejection through onLoadError', async () => {
    const onLoadError = vi.fn()
    const host = fakeHost(() => Promise.reject(new IslandLoadError('/w/hello/x.html: HTTP 404')))

    render(<IslandFrame {...PROPS} host={host} onLoadError={onLoadError} />)

    await waitFor(() =>
      expect(onLoadError).toHaveBeenCalledWith({
        code: 'ISLAND_LOAD',
        message: '/w/hello/x.html: HTTP 404',
      }),
    )
  })

  it('does not report a load error after the frame has been unmounted', async () => {
    const onLoadError = vi.fn()
    const host = fakeHost(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new IslandLoadError('too late')), 5)
        }),
    )

    const { unmount } = render(<IslandFrame {...PROPS} host={host} onLoadError={onLoadError} />)
    unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(onLoadError).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// apps#370 — a viewer's value changes without a remount
// ---------------------------------------------------------------------------

describe('IslandFrame — viewer tool-input (#370)', () => {
  it('re-sends tool-input when a viewer\'s arguments change, without a second mount', async () => {
    const host = fakeHost()
    const { rerender } = render(<IslandFrame {...PROPS} host={host} viewer arguments={{ value: 1 }} />)
    await waitFor(() => expect(host.mounts).toBe(1))

    rerender(<IslandFrame {...PROPS} host={host} viewer arguments={{ value: 2 }} />)
    await waitFor(() => expect(host.inputs).toEqual([{ value: 2 }]))

    // A structurally identical, freshly allocated value (every poll of a live
    // run) is not a change.
    rerender(<IslandFrame {...PROPS} host={host} viewer arguments={{ value: 2 }} />)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(host.inputs).toEqual([{ value: 2 }])
    expect(host.mounts).toBe(1)
  })

  it("never re-sends to a step's island", async () => {
    const host = fakeHost()
    const { rerender } = render(<IslandFrame {...PROPS} host={host} arguments={{ value: 1 }} />)
    await waitFor(() => expect(host.mounts).toBe(1))

    rerender(<IslandFrame {...PROPS} host={host} arguments={{ value: 2 }} />)
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(host.inputs).toEqual([])
    expect(host.mounts).toBe(1)
  })

  it('delivers a value that changed while the island was still loading, once it is up', async () => {
    let release!: () => void
    const host = fakeHost(() => new Promise<void>((resolve) => (release = resolve)))
    const { rerender } = render(<IslandFrame {...PROPS} host={host} viewer arguments={{ value: 1 }} />)
    await waitFor(() => expect(host.mounts).toBe(1))

    rerender(<IslandFrame {...PROPS} host={host} viewer arguments={{ value: 2 }} />)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(host.inputs).toEqual([])

    release()
    await waitFor(() => expect(host.inputs).toEqual([{ value: 2 }]))
  })
})
