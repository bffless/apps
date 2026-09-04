import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { InputDef } from '@bffless/workflow-lint/definition'
import { StepForm, type StepFormProps } from './StepForm'

const A = { path: 'workflows/x/a.svg', name: 'a.svg', contentType: 'image/svg+xml', size: 1, url: '/api/uploads/workflows/x/a.svg' }
const B = { ...A, path: 'workflows/x/b.svg', name: 'b.svg', url: '/api/uploads/workflows/x/b.svg' }
const fields: Record<string, InputDef> = {
  cover: { type: 'choice', options: [A, B], required: true } as InputDef,
  notes: { type: 'markdown', default: '## Notes' } as InputDef,
  extra: { type: 'file', accept: 'image/*' } as InputDef,
}
const initial = { cover: null, notes: '## Notes', extra: null }

function renderForm(onSubmit: StepFormProps['onSubmit'] = vi.fn(async () => ({ ok: true as const }))) {
  render(<StepForm title="Review the card" submitLabel="Approve" fields={fields} initial={initial} onSubmit={onSubmit} />)
  return onSubmit
}

describe('StepForm', () => {
  it('renders the evaluated fields with the harness controls and the form’s own submit label', () => {
    renderForm()
    expect(screen.getByRole('heading', { name: 'Review the card' })).toBeInTheDocument()
    expect(screen.getAllByTestId('tile')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled() // cover is required and blank
  })

  it('submits the values once a required field is answered, and shows the server’s per-field refusal', async () => {
    const onSubmit = vi.fn(async (values: Record<string, unknown>) => (values.notes === 'bad' ? { ok: false as const, errors: { notes: 'Expected a valid markdown value' } } : { ok: true as const }))
    renderForm(onSubmit)
    fireEvent.click(screen.getAllByTestId('tile')[0]!)
    fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(screen.getByText('Expected a valid markdown value')).toBeInTheDocument())
    expect(onSubmit).toHaveBeenLastCalledWith({ cover: A.path, notes: 'bad', extra: null })
    fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: 'fine' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()) // submitted once; never twice
    expect(onSubmit).toHaveBeenLastCalledWith({ cover: A.path, notes: 'fine', extra: null })
  })

  it('refuses to upload from inside an agent host and says where to attach the file', async () => {
    renderForm()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] } })
    await waitFor(() => expect(screen.getByText(/attach this one on the harness page/)).toBeInTheDocument())
  })
})
