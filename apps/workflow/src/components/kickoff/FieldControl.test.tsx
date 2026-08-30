/**
 * `FieldControl` (02/08) — the two upgrades Task 18 adds to the shared field
 * renderer, plus the accessibility rule that binds every control:
 *
 * - a `choice` whose options carry a **preview** (a File ref, or the 02
 *   shorthand where the option *is* a File ref) is a tile picker, not a
 *   `<select>`: the value it emits is still the plain option value (a File
 *   ref's `path`), and an image preview only ever reaches an `<img src>`
 *   through `isSameOriginUrl`;
 * - a `markdown` field can toggle a live preview beside the (still editable)
 *   textarea;
 * - every control says `aria-invalid` and points at its error's id.
 *
 * Tiles are `<button aria-pressed>`, not radios: see `TilePicker.tsx` for why
 * the radiogroup role went away (it promised a keyboard pattern this never
 * implemented).
 */
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InputDef } from '@bffless/workflow-lint/definition'
import type { FileRef } from '../../lib/runner/types'
import { FieldControl } from './FieldControl'

const A: FileRef = {
  path: 'workflows/hello/hello/runs/r/draw/a.png',
  name: 'a.png',
  contentType: 'image/png',
  size: 11,
  url: '/api/uploads/hello/hello/runs/r/draw/a.png',
}
const B: FileRef = {
  ...A,
  path: 'workflows/hello/hello/runs/r/draw/b.png',
  name: 'b.png',
  url: '/api/uploads/hello/hello/runs/r/draw/b.png',
}

/** The controlled wrapper the real forms are — a click has to come back as a new `value`. */
function Controlled({
  def,
  initial = null,
  error,
  onChange,
  upload,
}: {
  def: InputDef
  initial?: unknown
  error?: string
  onChange?: (v: unknown) => void
  upload?: (file: File, onProgress: (fraction: number) => void) => Promise<FileRef>
}) {
  const [value, setValue] = useState<unknown>(initial)
  return (
    <FieldControl
      name="cover"
      def={def}
      value={value}
      error={error}
      upload={upload}
      onChange={(v) => {
        setValue(v)
        onChange?.(v)
      }}
    />
  )
}

describe('FieldControl — tile picker (02: options with a preview)', () => {
  it('renders one tile per File-ref option and selects by path', () => {
    const onChange = vi.fn()
    render(<Controlled def={{ type: 'choice', options: [A, B] }} onChange={onChange} />)

    const picker = screen.getByTestId('tile-picker')
    const tiles = screen.getAllByTestId('tile')
    expect(tiles).toHaveLength(2)
    expect(tiles.map((t) => t.getAttribute('data-value'))).toEqual([A.path, B.path])
    expect(picker).toHaveAttribute('role', 'group')
    expect(picker).toHaveAccessibleName('cover')
    expect(tiles[0]).toHaveAttribute('aria-pressed', 'false')
    // Not a radiogroup: the pattern that role promises (roving tabindex, arrow
    // keys) is not implemented, so the tiles claim only what they do.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(picker.querySelectorAll('img')).toHaveLength(2)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    fireEvent.click(tiles[1]!)

    expect(onChange).toHaveBeenCalledWith(B.path)
    expect(screen.getAllByTestId('tile')[1]).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders tiles for a {value,label,preview} option list too', () => {
    render(
      <Controlled def={{ type: 'choice', options: [{ value: 'a', label: 'A', preview: '/api/uploads/a.png' }] }} />,
    )

    const tile = screen.getByTestId('tile')
    expect(tile).toHaveAttribute('data-value', 'a')
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/uploads/a.png')
    expect(screen.getByText('A')).toBeInTheDocument()
  })

  it('refuses a cross-origin preview url as an image source', () => {
    render(
      <Controlled
        def={{ type: 'choice', options: [{ value: 'a', label: 'A', preview: 'https://evil.example/a.png' }] }}
      />,
    )

    expect(screen.getByTestId('tile')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('multi-selects with checkbox tiles when the field is a list', () => {
    const onChange = vi.fn()
    render(<Controlled def={{ type: 'choice', list: true, options: [A, B] }} onChange={onChange} />)

    const tiles = screen.getAllByTestId('tile')
    expect(tiles[0]).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    fireEvent.click(tiles[0]!)
    expect(onChange).toHaveBeenLastCalledWith([A.path])
    fireEvent.click(screen.getAllByTestId('tile')[1]!)
    expect(onChange).toHaveBeenLastCalledWith([A.path, B.path])
    fireEvent.click(screen.getAllByTestId('tile')[0]!)
    expect(onChange).toHaveBeenLastCalledWith([B.path])
  })

  it('keeps the plain select for options with no preview', () => {
    render(<Controlled def={{ type: 'choice', options: ['short', 'medium'] }} />)

    expect(screen.queryByTestId('tile-picker')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  // A zero-tile options list can never reach the tile picker itself: `choice`
  // only takes that branch when some option carries a preview
  // (`options.some((opt) => opt.preview !== undefined)`), and `.some` on an
  // empty array is always `false` — so an evaluated-to-nothing `options`
  // always falls through to the plain `<select>`, which must still show its
  // disabled placeholder rather than an empty, unusable dropdown.
  it('keeps the select and its disabled placeholder when options evaluated to nothing', () => {
    render(<Controlled def={{ type: 'choice', options: [] }} />)

    expect(screen.queryByTestId('tile-picker')).not.toBeInTheDocument()
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.options).toHaveLength(1)
    expect(select.options[0]?.textContent).toBe('Choose…')
    expect(select.options[0]?.disabled).toBe(true)
  })
})

describe('FieldControl — the grouped choice renderings name themselves', () => {
  // A `<label htmlFor>` can only point at one labelable element, and both
  // grouped renderings are a set of controls inside a `<div>` — the caption
  // used to point at an id nothing carried, naming neither. They are
  // `role="group"` named after the field instead (apps#379).
  it.each([
    ['tiles', { type: 'choice', options: [A, B] } as InputDef],
    ['checkboxes', { type: 'choice', list: true, options: ['s', 'm'] } as InputDef],
  ])('names the %s group after the field and dangles no label at it', (_name, def) => {
    render(<Controlled def={def} />)

    expect(screen.getByRole('group', { name: 'cover' })).toBeInTheDocument()
    expect(document.querySelector('label[for]')).toBeNull()
  })

  it('still points the caption at the control for an ungrouped field', () => {
    render(<Controlled def={{ type: 'choice', options: ['s', 'm'] }} />)

    expect(screen.getByLabelText('cover')).toBe(screen.getByRole('combobox'))
  })
})

describe('FieldControl — what counts as a preview (apps#379)', () => {
  // The tile picker is chosen by "does any option carry a preview", so
  // anything that reads as one flips the whole field out of its `<select>`.
  // A preview is a *picture*: a url string or a File ref. `preview: null` (a
  // pipeline that had nothing to show for that option) is not one.
  it.each([
    ['null', null],
    ['a number', 3],
    ['an object that is not a File ref', { width: 40 }],
    ['an empty string', ''],
  ])('keeps the select when an option carries %s as its preview', (_name, preview) => {
    render(
      <Controlled
        def={{ type: 'choice', options: [{ value: 'a', label: 'A', preview }, { value: 'b', label: 'B' }] }}
      />,
    )

    expect(screen.queryByTestId('tile-picker')).not.toBeInTheDocument()
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['', 'a', 'b'])
  })

  it('still takes the tile branch for a File-ref option whose own preview key is null', () => {
    render(<Controlled def={{ type: 'choice', options: [{ ...A, preview: null }] }} />)

    // 02's shorthand: the option *is* a File ref, so it is its own preview —
    // an explicit `preview: null` beside it does not take that away.
    expect(screen.getByTestId('tile')).toHaveAttribute('data-value', A.path)
    expect(screen.getByRole('img')).toHaveAttribute('src', A.url)
  })

  it('renders every option as a tile when only some carry a preview', () => {
    const onChange = vi.fn()
    render(
      <Controlled
        def={{ type: 'choice', options: [A, 'none', { value: 'b', label: 'B', preview: null }] }}
        onChange={onChange}
      />,
    )

    const tiles = screen.getAllByTestId('tile')
    expect(tiles.map((t) => t.getAttribute('data-value'))).toEqual([A.path, 'none', 'b'])
    // One picture between them — the previewless options are label-only tiles,
    // not missing options, so every value the submit will accept is clickable.
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    fireEvent.click(tiles[1]!)
    expect(onChange).toHaveBeenCalledWith('none')
  })
})

describe('FieldControl — file fields', () => {
  const upload = (ref: FileRef) => vi.fn().mockResolvedValue(ref)

  const DOC: FileRef = { ...A, path: 'p/one.txt', name: 'one.txt', contentType: 'text/plain', url: '/api/uploads/p/one.txt' }
  const DOC2: FileRef = { ...DOC, path: 'p/two.txt', name: 'two.txt', url: '/api/uploads/p/two.txt' }

  it('uploads every file of one multi-select pick and lists them all', async () => {
    const onChange = vi.fn()
    const up = vi.fn(async (file: File) => (file.name === 'one.txt' ? DOC : DOC2))
    render(<Controlled def={{ type: 'file', list: true }} initial={[]} onChange={onChange} upload={up} />)

    fireEvent.change(screen.getByLabelText('cover'), {
      target: {
        files: [new File(['a'], 'one.txt', { type: 'text/plain' }), new File(['b'], 'two.txt', { type: 'text/plain' })],
      },
    })

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([DOC, DOC2]))
    expect(screen.getByText('one.txt')).toBeInTheDocument()
    expect(screen.getByText('two.txt')).toBeInTheDocument()
  })

  // The regression: `[...refs, ...uploaded]` used to close over the `refs` of
  // the render that *started* the upload, so a second pick made before the
  // first landed emitted a list without the first file in it.
  it('appends a second pick to the first even when the first has not landed yet', async () => {
    const gate: ((ref: FileRef) => void)[] = []
    const up = vi.fn(() => new Promise<FileRef>((resolve) => gate.push(resolve)))
    const onChange = vi.fn()
    render(<Controlled def={{ type: 'file', list: true }} initial={[]} onChange={onChange} upload={up} />)

    const input = screen.getByLabelText('cover')
    fireEvent.change(input, { target: { files: [new File(['a'], 'one.txt')] } })
    fireEvent.change(input, { target: { files: [new File(['b'], 'two.txt')] } })
    expect(up).toHaveBeenCalledTimes(2)

    gate[0]!(DOC)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([DOC]))
    gate[1]!(DOC2)
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([DOC, DOC2]))

    expect(screen.getByText('one.txt')).toBeInTheDocument()
    expect(screen.getByText('two.txt')).toBeInTheDocument()
  })

  it('replaces rather than appends when the field is not a list', async () => {
    const onChange = vi.fn()
    render(<Controlled def={{ type: 'file' }} initial={DOC} onChange={onChange} upload={upload(DOC2)} />)

    fireEvent.change(screen.getByLabelText('cover'), { target: { files: [new File(['b'], 'two.txt')] } })

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(DOC2))
  })

  // apps#437: a person attaching a reference photo should see the photo, not
  // just its file name — on the kickoff form and on a form step alike, since
  // both render this control.
  describe('image preview (apps#437)', () => {
    const PHOTO: FileRef = {
      ...A,
      path: 'workflows/hello/hello/inputs/1/me.jpg',
      name: 'me.jpg',
      contentType: 'image/jpeg',
      url: '/api/uploads/workflows/hello/hello/inputs/1/me.jpg',
    }

    it('shows a thumbnail beside the name once an image/* upload lands', async () => {
      render(<Controlled def={{ type: 'file', accept: 'image/*' }} upload={upload(PHOTO)} />)
      expect(screen.queryByTestId('file-preview')).not.toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('cover'), {
        target: { files: [new File(['jpg'], 'me.jpg', { type: 'image/jpeg' })] },
      })

      const preview = await screen.findByTestId('file-preview')
      expect(preview.tagName).toBe('IMG')
      expect(preview).toHaveAttribute('src', PHOTO.url)
      expect(preview).toHaveAttribute('alt', 'me.jpg')
      expect(screen.getByText('me.jpg')).toBeInTheDocument()
    })

    it('previews a prefilled image ref (Re-run) without an upload', () => {
      const up = vi.fn()
      render(<Controlled def={{ type: 'file', accept: 'image/*' }} initial={PHOTO} upload={up} />)

      expect(screen.getByTestId('file-preview')).toHaveAttribute('src', PHOTO.url)
      expect(up).not.toHaveBeenCalled()
    })

    it('shows no thumbnail for a non-image upload', async () => {
      render(<Controlled def={{ type: 'file' }} upload={upload(DOC)} />)

      fireEvent.change(screen.getByLabelText('cover'), {
        target: { files: [new File(['a'], 'one.txt', { type: 'text/plain' })] },
      })

      expect(await screen.findByText('one.txt')).toBeInTheDocument()
      expect(screen.queryByTestId('file-preview')).not.toBeInTheDocument()
    })

    it('refuses a cross-origin url as the thumbnail source but still names the file', () => {
      render(
        <Controlled
          def={{ type: 'file', accept: 'image/*' }}
          initial={{ ...PHOTO, url: 'https://evil.example/me.jpg' }}
          upload={vi.fn()}
        />,
      )

      expect(screen.getByText('me.jpg')).toBeInTheDocument()
      expect(screen.queryByTestId('file-preview')).not.toBeInTheDocument()
      expect(document.querySelector('img')).toBeNull()
    })
  })

  // apps#451: before a ten-minute run starts, the person wants to confirm the
  // recording is the right one — play it, scrub it, see how long it is — on
  // the kickoff form and on a form step alike. jsdom plays nothing, so these
  // pin the DOM: which element, which `src`, which attributes, and that no
  // player starts on its own.
  describe('video and audio preview (apps#451)', () => {
    const TAKE: FileRef = {
      ...A,
      path: 'workflows/hello/hello/inputs/1/take-1.mp4',
      name: 'take-1.mp4',
      contentType: 'video/mp4',
      size: 2048,
      url: '/api/uploads/workflows/hello/hello/inputs/1/take-1.mp4',
    }
    const TAKE2: FileRef = {
      ...TAKE,
      path: 'workflows/hello/hello/inputs/1/take-2.mp4',
      name: 'take-2.mp4',
      url: '/api/uploads/workflows/hello/hello/inputs/1/take-2.mp4',
    }
    const VOICE: FileRef = {
      ...TAKE,
      path: 'workflows/hello/hello/inputs/1/memo.m4a',
      name: 'memo.m4a',
      contentType: 'audio/mp4',
      url: '/api/uploads/workflows/hello/hello/inputs/1/memo.m4a',
    }
    const PHOTO: FileRef = {
      ...A,
      path: 'workflows/hello/hello/inputs/1/me.jpg',
      name: 'me.jpg',
      contentType: 'image/jpeg',
      url: '/api/uploads/workflows/hello/hello/inputs/1/me.jpg',
    }

    // jsdom has no object URLs and no media playback: stub both, and restore
    // whatever was there so the other suites see the environment they expect.
    const createObjectURL = vi.fn<(blob: Blob) => string>()
    const revokeObjectURL = vi.fn<(url: string) => void>()
    const play = vi.fn<() => Promise<void>>()
    const restore: (() => void)[] = []
    function stub(target: object, name: string, value: unknown) {
      const original = Object.getOwnPropertyDescriptor(target, name)
      Object.defineProperty(target, name, { configurable: true, writable: true, value })
      restore.push(() => {
        if (original) Object.defineProperty(target, name, original)
        else delete (target as Record<string, unknown>)[name]
      })
    }
    beforeEach(() => {
      let n = 0
      createObjectURL.mockReset().mockImplementation(() => `blob:harness/${++n}`)
      revokeObjectURL.mockReset()
      play.mockReset().mockResolvedValue(undefined)
      stub(URL, 'createObjectURL', createObjectURL)
      stub(URL, 'revokeObjectURL', revokeObjectURL)
      stub(HTMLMediaElement.prototype, 'play', play)
    })
    afterEach(() => {
      while (restore.length > 0) restore.pop()!()
    })

    function loadMetadata(el: Element, duration: number) {
      Object.defineProperty(el, 'duration', { configurable: true, value: duration })
      fireEvent(el, new Event('loadedmetadata'))
    }

    it('plays the chosen video from the local file while it uploads, then from its serve url once registered', async () => {
      let land: ((ref: FileRef) => void) | undefined
      const up = vi.fn(() => new Promise<FileRef>((resolve) => (land = resolve)))
      render(<Controlled def={{ type: 'file', accept: 'video/*' }} upload={up} />)
      expect(screen.queryByTestId('file-media')).not.toBeInTheDocument()

      const file = new File(['mp4'], 'take-1.mp4', { type: 'video/mp4' })
      fireEvent.change(screen.getByLabelText('cover'), { target: { files: [file] } })

      const video = await screen.findByTestId('file-media')
      expect(video.tagName).toBe('VIDEO')
      expect(video).toHaveAttribute('controls')
      expect(video).toHaveAttribute('preload', 'metadata')
      expect(video).not.toHaveAttribute('autoplay')
      expect(createObjectURL).toHaveBeenCalledWith(file)
      expect(video).toHaveAttribute('src', 'blob:harness/1')
      expect(screen.getByText('take-1.mp4')).toBeInTheDocument()
      // A single field's player is open from the start: nothing to click through.
      expect(screen.queryByRole('button', { name: /^Play / })).not.toBeInTheDocument()
      expect(revokeObjectURL).not.toHaveBeenCalled()

      land!(TAKE)
      await waitFor(() => expect(screen.getByTestId('file-media')).toHaveAttribute('src', TAKE.url))
      expect(screen.getAllByTestId('file-media')).toHaveLength(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:harness/1')
      expect(play).not.toHaveBeenCalled()
    })

    it('shows the duration beside the name and size once the metadata loads', () => {
      render(<Controlled def={{ type: 'file', accept: 'video/*' }} initial={TAKE} upload={vi.fn()} />)

      const video = screen.getByTestId('file-media')
      expect(video).toHaveAttribute('src', TAKE.url)
      expect(screen.getByText('2.0 KB')).toBeInTheDocument()
      expect(screen.queryByTestId('file-duration')).not.toBeInTheDocument()

      loadMetadata(video, 83.4)

      expect(screen.getByTestId('file-duration')).toHaveTextContent('1:23')
      expect(createObjectURL).not.toHaveBeenCalled()
    })

    it('previews an audio/* file with an <audio> player', () => {
      render(<Controlled def={{ type: 'file', accept: 'audio/*' }} initial={VOICE} upload={vi.fn()} />)

      const audio = screen.getByTestId('file-media')
      expect(audio.tagName).toBe('AUDIO')
      expect(audio).toHaveAttribute('controls')
      expect(audio).toHaveAttribute('preload', 'metadata')
      expect(audio).toHaveAttribute('src', VOICE.url)
      expect(screen.getByText('memo.m4a')).toBeInTheDocument()
    })

    it("collapses a list's players behind one Play control each, and opens only the one clicked", () => {
      render(<Controlled def={{ type: 'file', accept: 'video/*', list: true }} initial={[TAKE, TAKE2]} upload={vi.fn()} />)

      const players = screen.getAllByTestId('file-media')
      expect(players).toHaveLength(2)
      expect(players.map((p) => p.tagName)).toEqual(['VIDEO', 'VIDEO'])
      expect(players.map((p) => p.getAttribute('src'))).toEqual([TAKE.url, TAKE2.url])
      for (const p of players) {
        expect(p).toHaveAttribute('preload', 'metadata')
        expect(p).not.toHaveAttribute('controls')
        expect(p).not.toHaveAttribute('autoplay')
      }
      expect(screen.getAllByRole('button', { name: /^Play / })).toHaveLength(2)
      expect(play).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Play take-2.mp4' }))

      const [first, second] = screen.getAllByTestId('file-media')
      expect(second).toHaveAttribute('controls')
      expect(first).not.toHaveAttribute('controls')
      expect(play).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('button', { name: 'Play take-2.mp4' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Play take-1.mp4' })).toBeInTheDocument()
    })

    it('refuses a cross-origin url as the player source but still names the file', () => {
      render(
        <Controlled
          def={{ type: 'file', accept: 'video/*' }}
          initial={{ ...TAKE, url: 'https://evil.example/take-1.mp4' }}
          upload={vi.fn()}
        />,
      )

      expect(screen.getByText('take-1.mp4')).toBeInTheDocument()
      expect(screen.queryByTestId('file-media')).not.toBeInTheDocument()
      expect(document.querySelector('video, audio')).toBeNull()
    })

    it('shows no player and no thumbnail for a document', () => {
      render(<Controlled def={{ type: 'file' }} initial={DOC} upload={vi.fn()} />)

      expect(screen.getByText('one.txt')).toBeInTheDocument()
      expect(screen.queryByTestId('file-media')).not.toBeInTheDocument()
      expect(screen.queryByTestId('file-preview')).not.toBeInTheDocument()
    })

    it('mints no object url for an image or a document upload — the thumbnail waits for the registered url (apps#437)', async () => {
      const up = vi.fn(async (file: File) => (file.type === 'image/jpeg' ? PHOTO : DOC))
      render(<Controlled def={{ type: 'file', list: true }} initial={[]} upload={up} />)

      fireEvent.change(screen.getByLabelText('cover'), {
        target: {
          files: [new File(['jpg'], 'me.jpg', { type: 'image/jpeg' }), new File(['a'], 'one.txt', { type: 'text/plain' })],
        },
      })

      expect(await screen.findByTestId('file-preview')).toHaveAttribute('src', PHOTO.url)
      expect(screen.getByText('one.txt')).toBeInTheDocument()
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(screen.queryByTestId('file-media')).not.toBeInTheDocument()
    })

    it("revokes a failed upload's object url and drops its row", async () => {
      const up = vi.fn().mockRejectedValue(new Error('storage said no'))
      render(<Controlled def={{ type: 'file', accept: 'video/*' }} upload={up} />)

      fireEvent.change(screen.getByLabelText('cover'), {
        target: { files: [new File(['mp4'], 'take-1.mp4', { type: 'video/mp4' })] },
      })

      expect(await screen.findByTestId('file-media')).toHaveAttribute('src', 'blob:harness/1')
      await waitFor(() => expect(screen.queryByTestId('file-media')).not.toBeInTheDocument())
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:harness/1')
      expect(screen.getByText('storage said no')).toBeInTheDocument()
    })

    it('revokes every object url still alive when it unmounts mid-upload', async () => {
      const up = vi.fn(() => new Promise<FileRef>(() => {}))
      const { unmount } = render(<Controlled def={{ type: 'file', accept: 'video/*', list: true }} initial={[]} upload={up} />)

      fireEvent.change(screen.getByLabelText('cover'), {
        target: {
          files: [
            new File(['a'], 'take-1.mp4', { type: 'video/mp4' }),
            new File(['b'], 'take-2.mp4', { type: 'video/mp4' }),
          ],
        },
      })
      expect(await screen.findAllByTestId('file-media')).toHaveLength(2)
      expect(revokeObjectURL).not.toHaveBeenCalled()

      unmount()

      expect(revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual(['blob:harness/1', 'blob:harness/2'])
    })
  })
})

describe('FieldControl — markdown preview', () => {
  it('toggles a rendered preview beside the editable textarea', () => {
    render(<Controlled def={{ type: 'markdown' }} initial={'## Notes'} />)

    const toggle = screen.getByRole('button', { name: /preview/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument()

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const preview = screen.getByTestId('markdown-preview')
    expect(preview.querySelector('h2')?.textContent).toBe('Notes')

    // The textarea stays editable, and the preview follows what is typed.
    fireEvent.change(screen.getByLabelText('cover'), { target: { value: '## Edited' } })
    expect(screen.getByTestId('markdown-preview').querySelector('h2')?.textContent).toBe('Edited')

    fireEvent.click(screen.getByRole('button', { name: /preview/i }))
    expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument()
  })
})

describe('FieldControl — aria-invalid (M1 minor)', () => {
  it.each([
    ['string', { type: 'string' } as InputDef, 'textbox'],
    ['number', { type: 'number' } as InputDef, 'spinbutton'],
    ['boolean', { type: 'boolean' } as InputDef, 'checkbox'],
    ['choice', { type: 'choice', options: ['a'] } as InputDef, 'combobox'],
    ['markdown', { type: 'markdown' } as InputDef, 'textbox'],
  ])('marks a %s control invalid only while an error is shown', (_name, def, role) => {
    const { unmount } = render(<Controlled def={def} />)
    expect(screen.getByRole(role)).toHaveAttribute('aria-invalid', 'false')
    unmount()

    render(<Controlled def={def} error="Nope" />)
    const control = screen.getByRole(role)
    expect(control).toHaveAttribute('aria-invalid', 'true')
    expect(control.getAttribute('aria-describedby')).toBe(screen.getByText('Nope').id)
  })

  it('marks the tile picker and the file input invalid too', () => {
    const { unmount } = render(<Controlled def={{ type: 'choice', options: [A] }} error="Pick one" />)
    const picker = screen.getByTestId('tile-picker')
    expect(picker).toHaveAttribute('aria-invalid', 'true')
    expect(picker.getAttribute('aria-describedby')).toBe(screen.getByText('Pick one').id)
    unmount()

    render(
      <FieldControl
        name="doc"
        def={{ type: 'file' }}
        value={null}
        onChange={vi.fn()}
        upload={vi.fn()}
        error="Too big"
      />,
    )
    const input = screen.getByLabelText('doc')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByText('Too big').id)
  })
})
