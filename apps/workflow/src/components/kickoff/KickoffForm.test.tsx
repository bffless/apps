/**
 * `KickoffForm` (08): the form generated from `on.manual.inputs`, against
 * hello's real four inputs so a schema drift in the fixture workflow fails
 * this test instead of silently going unnoticed.
 */
import { act } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { InputDef } from '@bffless/workflow-lint/definition'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from '../../lib/runner/definition'
import type { FileRef } from '../../lib/runner/types'
import { KickoffForm } from './KickoffForm'

const loaded = loadWorkflow(helloYaml, 'hello.workflow.yaml')
if (!loaded.def) throw new Error('hello.workflow.yaml no longer parses')
const inputs = loaded.def.inputs

function renderForm(overrides: {
  inputs?: Record<string, InputDef>
  initial?: Record<string, unknown>
  uploading?: (file: File, onProgress: (f: number) => void) => Promise<FileRef>
  onStart?: (values: Record<string, unknown>) => void
} = {}) {
  const onStart = overrides.onStart ?? vi.fn()
  const uploading = overrides.uploading ?? vi.fn()
  render(
    <KickoffForm
      inputs={overrides.inputs ?? inputs}
      initial={overrides.initial}
      uploading={uploading}
      onStart={onStart}
    />,
  )
  return { onStart, uploading, form: screen.getByTestId('kickoff-form') }
}

describe('KickoffForm', () => {
  it('renders one control per declared input, pre-filled with its default', () => {
    const { form } = renderForm()

    expect(within(form).getByLabelText(/^Greeting/)).toHaveValue('Hello')
    expect(within(form).getByLabelText('world')).toBeChecked()
    expect(within(form).getByLabelText('studio')).not.toBeChecked()
    expect(within(form).getByLabelText('shout')).not.toBeChecked()
    expect(within(form).getByLabelText(/A photo/)).toBeInTheDocument()

    expect(within(form).getByTestId('kickoff-start')).not.toBeDisabled()
  })

  it('disables Start when a required field is cleared', () => {
    const { form } = renderForm()

    fireEvent.change(within(form).getByLabelText(/^Greeting/), { target: { value: '' } })

    expect(within(form).getByTestId('kickoff-start')).toBeDisabled()
  })

  it('re-enables Start once the required field is filled back in', () => {
    const { form } = renderForm()

    fireEvent.change(within(form).getByLabelText(/^Greeting/), { target: { value: '' } })
    expect(within(form).getByTestId('kickoff-start')).toBeDisabled()

    fireEvent.change(within(form).getByLabelText(/^Greeting/), { target: { value: 'Hi' } })
    expect(within(form).getByTestId('kickoff-start')).not.toBeDisabled()
  })

  it('uploads a selected file, disables Start until it resolves, then holds the FileRef', async () => {
    let resolveUpload: ((ref: FileRef) => void) | undefined
    const uploading = vi.fn(
      () =>
        new Promise<FileRef>((resolve) => {
          resolveUpload = resolve
        }),
    )
    const { form, onStart } = renderForm({ uploading })

    const file = new File(['bytes'], 'photo.png', { type: 'image/png' })
    const fileInput = within(form).getByLabelText(/A photo/) as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [file] } })

    expect(uploading).toHaveBeenCalledWith(file, expect.any(Function))
    expect(within(form).getByTestId('kickoff-start')).toBeDisabled()

    const ref: FileRef = {
      path: 'workflows/hello/hello/inputs/1/photo.png',
      name: 'photo.png',
      contentType: 'image/png',
      size: 5,
      url: '/api/uploads/hello/hello/inputs/1/photo.png',
    }
    await act(async () => {
      resolveUpload!(ref)
    })

    await waitFor(() => expect(within(form).getByTestId('kickoff-start')).not.toBeDisabled())

    fireEvent.click(within(form).getByTestId('kickoff-start'))
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ photo: ref, greeting: 'Hello', names: ['world'], shout: false }),
    )
  })

  it('submits the current values map on Start', () => {
    const { form, onStart } = renderForm()

    fireEvent.click(within(form).getByLabelText('studio'))
    fireEvent.click(within(form).getByLabelText('shout'))
    fireEvent.click(within(form).getByTestId('kickoff-start'))

    expect(onStart).toHaveBeenCalledWith({
      greeting: 'Hello',
      names: ['world', 'studio'],
      photo: null,
      shout: true,
    })
  })

  it('prefills from a previous run for Re-run, without re-uploading its file', () => {
    const ref: FileRef = {
      path: 'workflows/hello/hello/inputs/1/photo.png',
      name: 'photo.png',
      contentType: 'image/png',
      size: 5,
      url: '/api/uploads/hello/hello/inputs/1/photo.png',
    }
    const uploading = vi.fn()
    const { form } = renderForm({
      initial: { greeting: 'Hi', names: ['reader'], shout: true, photo: ref },
      uploading,
    })

    expect(within(form).getByLabelText(/^Greeting/)).toHaveValue('Hi')
    expect(within(form).getByLabelText('reader')).toBeChecked()
    expect(within(form).getByLabelText('shout')).toBeChecked()
    expect(uploading).not.toHaveBeenCalled()
  })

  // apps#437: the kickoff's own `file` inputs get the same thumbnail a form
  // step's do — the field renderer is shared, but this is the surface the
  // issue names first, so it is pinned here as well.
  it('previews an image/* upload beside its name (apps#437)', () => {
    const ref: FileRef = {
      path: 'workflows/hello/hello/inputs/1/photo.png',
      name: 'photo.png',
      contentType: 'image/png',
      size: 5,
      url: '/api/uploads/workflows/hello/hello/inputs/1/photo.png',
    }
    const { form } = renderForm({ initial: { greeting: 'Hi', names: ['reader'], shout: false, photo: ref } })

    const preview = within(form).getByTestId('file-preview')
    expect(preview).toHaveAttribute('src', ref.url)
    expect(preview).toHaveAttribute('alt', 'photo.png')
    expect(within(form).getByText('photo.png')).toBeInTheDocument()
  })

  it('renders a tile picker for a choice input whose options carry previews (02)', () => {
    const tiled: Record<string, InputDef> = {
      cover: { type: 'choice', options: [{ value: 'a', label: 'A', preview: '/api/uploads/a.png' }] },
    }
    const { form, onStart } = renderForm({ inputs: tiled })

    expect(within(form).getByTestId('tile-picker')).toBeInTheDocument()
    fireEvent.click(within(form).getByTestId('tile'))
    fireEvent.click(within(form).getByTestId('kickoff-start'))

    expect(onStart).toHaveBeenCalledWith({ cover: 'a' })
  })

  describe('input-specific constraints on submit (02: min/max, pattern/length, choice membership)', () => {
    it('blocks submit and shows an inline error when a number is outside min/max', () => {
      const numberInputs: Record<string, InputDef> = { count: { type: 'number', min: 1, max: 5, default: 1 } }
      const { form, onStart } = renderForm({ inputs: numberInputs })

      fireEvent.change(within(form).getByLabelText('count'), { target: { value: '9' } })
      fireEvent.click(within(form).getByTestId('kickoff-start'))

      expect(within(form).getByText(/at most 5/)).toBeInTheDocument()
      expect(onStart).not.toHaveBeenCalled()
    })

    it('blocks submit when a string is shorter than minLength or longer than maxLength', () => {
      const stringInputs: Record<string, InputDef> = {
        code: { type: 'string', minLength: 3, maxLength: 5, default: '' },
      }
      const { form, onStart } = renderForm({ inputs: stringInputs })

      fireEvent.change(within(form).getByLabelText('code'), { target: { value: 'ab' } })
      fireEvent.click(within(form).getByTestId('kickoff-start'))

      expect(within(form).getByText(/at least 3/)).toBeInTheDocument()
      expect(onStart).not.toHaveBeenCalled()
    })

    it('blocks submit when a string does not match pattern', () => {
      const patternInputs: Record<string, InputDef> = {
        slug: { type: 'string', pattern: '^[a-z0-9-]+$', default: '' },
      }
      const { form, onStart } = renderForm({ inputs: patternInputs })

      fireEvent.change(within(form).getByLabelText('slug'), { target: { value: 'Not A Slug!' } })
      fireEvent.click(within(form).getByTestId('kickoff-start'))

      expect(within(form).getByText(/format/)).toBeInTheDocument()
      expect(onStart).not.toHaveBeenCalled()
    })

    it('lets a value back through once it is fixed to satisfy the constraint', () => {
      const numberInputs: Record<string, InputDef> = { count: { type: 'number', min: 1, max: 5, default: 1 } }
      const { form, onStart } = renderForm({ inputs: numberInputs })

      fireEvent.change(within(form).getByLabelText('count'), { target: { value: '9' } })
      fireEvent.click(within(form).getByTestId('kickoff-start'))
      expect(onStart).not.toHaveBeenCalled()

      fireEvent.change(within(form).getByLabelText('count'), { target: { value: '3' } })
      fireEvent.click(within(form).getByTestId('kickoff-start'))
      expect(onStart).toHaveBeenCalledWith({ count: 3 })
    })

    it('blocks submit on a stale prefilled choice value that is no longer a valid option', () => {
      // The exact scenario the review flagged: a `?from=` prefill (or any
      // `initial`) can carry a value from before the workflow's options
      // changed — membership must still be checked at submit time.
      const choiceInputs: Record<string, InputDef> = {
        length: { type: 'choice', options: ['short', 'medium'], default: 'short' },
      }
      const { form, onStart } = renderForm({ inputs: choiceInputs, initial: { length: 'long-removed-option' } })

      fireEvent.click(within(form).getByTestId('kickoff-start'))

      expect(within(form).getByText(/not one of/)).toBeInTheDocument()
      expect(onStart).not.toHaveBeenCalled()
    })

    it('blocks submit when any item of a choice list is not a valid option', () => {
      const choiceInputs: Record<string, InputDef> = {
        who: { type: 'choice', list: true, options: ['world', 'studio'], default: ['world'] },
      }
      const { form, onStart } = renderForm({ inputs: choiceInputs, initial: { who: ['world', 'stale'] } })

      fireEvent.click(within(form).getByTestId('kickoff-start'))

      expect(within(form).getByText(/not one of/)).toBeInTheDocument()
      expect(onStart).not.toHaveBeenCalled()
    })
  })
})

describe('KickoffForm — "Don\'t wait for me" (07)', () => {
  it('offers no toggle unless the page passes one', () => {
    const { form } = renderForm()
    expect(within(form).queryByTestId('kickoff-unattended')).toBeNull()
  })

  it('renders the toggle the page passes and reports each change, without touching the values', () => {
    const onChange = vi.fn()
    const onStart = vi.fn()
    render(
      <KickoffForm
        inputs={inputs}
        uploading={vi.fn()}
        onStart={onStart}
        unattended={{ value: false, onChange }}
      />,
    )
    const form = screen.getByTestId('kickoff-form')
    const toggle = within(form).getByTestId('kickoff-unattended')
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)

    fireEvent.click(within(form).getByTestId('kickoff-start'))
    // A run-level choice, never an input: the values are exactly the declared ones.
    expect(onStart).toHaveBeenCalledWith({ greeting: 'Hello', names: ['world'], photo: null, shout: false })
  })
})
