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
 */
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
}: {
  def: InputDef
  initial?: unknown
  error?: string
  onChange?: (v: unknown) => void
}) {
  const [value, setValue] = useState<unknown>(initial)
  return (
    <FieldControl
      name="cover"
      def={def}
      value={value}
      error={error}
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
    expect(tiles[0]).toHaveAttribute('role', 'radio')
    expect(tiles[0]).toHaveAttribute('aria-checked', 'false')
    expect(picker.querySelectorAll('img')).toHaveLength(2)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    fireEvent.click(tiles[1]!)

    expect(onChange).toHaveBeenCalledWith(B.path)
    expect(screen.getAllByTestId('tile')[1]).toHaveAttribute('aria-checked', 'true')
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
    expect(tiles[0]).toHaveAttribute('role', 'checkbox')

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
