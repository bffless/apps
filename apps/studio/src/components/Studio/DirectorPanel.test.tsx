import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DirectorPanel } from './DirectorPanel'

const noop = () => {}

function renderPanel(extra: Partial<Parameters<typeof DirectorPanel>[0]> = {}) {
  return render(
    <DirectorPanel
      value=""
      onChange={noop}
      onSubmit={noop}
      sheetCount={3}
      wordCount={1200}
      {...extra}
    />,
  )
}

describe('DirectorPanel rerun (story 03m)', () => {
  it('normal mode submits directly', () => {
    const onSubmit = vi.fn()
    renderPanel({ onSubmit })
    fireEvent.click(screen.getByRole('button', { name: /send to the ai director/i }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('rerun mode asks for confirmation instead of submitting', () => {
    const onSubmit = vi.fn()
    renderPanel({ onSubmit, rerun: true, sceneCount: 4 })
    fireEvent.click(screen.getByRole('button', { name: /re-run the ai director/i }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/replaces your 4 scenes and any build work/i)).toBeInTheDocument()
  })

  it('cancel backs out without submitting', () => {
    const onSubmit = vi.fn()
    renderPanel({ onSubmit, rerun: true, sceneCount: 2 })
    fireEvent.click(screen.getByRole('button', { name: /re-run the ai director/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.queryByText(/replaces your/i)).not.toBeInTheDocument()
  })

  it('replace & re-run fires onSubmit', () => {
    const onSubmit = vi.fn()
    renderPanel({ onSubmit, rerun: true, sceneCount: 2 })
    fireEvent.click(screen.getByRole('button', { name: /re-run the ai director/i }))
    fireEvent.click(screen.getByRole('button', { name: /replace & re-run/i }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
