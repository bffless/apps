import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { MediaImport } from './MediaImport'

const file = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'video/mp4' })

describe('MediaImport multi-select', () => {
  it('passes every accepted file up in one call', () => {
    const onSelect = vi.fn()
    render(<MediaImport onSelect={onSelect} />)
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file('a.mp4'), file('b.mp4')] } })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0]).toHaveLength(2)
  })
})
