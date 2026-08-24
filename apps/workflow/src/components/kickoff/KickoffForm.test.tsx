/**
 * `KickoffForm` (08): the form generated from `on.manual.inputs`, against
 * hello's real four inputs so a schema drift in the fixture workflow fails
 * this test instead of silently going unnoticed.
 */
import { act } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from '../../lib/runner/definition'
import type { FileRef } from '../../lib/runner/types'
import { KickoffForm } from './KickoffForm'

const loaded = loadWorkflow(helloYaml, 'hello.workflow.yaml')
if (!loaded.def) throw new Error('hello.workflow.yaml no longer parses')
const inputs = loaded.def.inputs

function renderForm(overrides: {
  initial?: Record<string, unknown>
  uploading?: (file: File, onProgress: (f: number) => void) => Promise<FileRef>
  onStart?: (values: Record<string, unknown>) => void
} = {}) {
  const onStart = overrides.onStart ?? vi.fn()
  const uploading = overrides.uploading ?? vi.fn()
  render(
    <KickoffForm
      inputs={inputs}
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
      url: '/api/workflow/files/hello/hello/inputs/1/photo.png',
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
      url: '/api/workflow/files/hello/hello/inputs/1/photo.png',
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
})
