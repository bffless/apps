import { describe, it, expect } from 'vitest'
import { mutationErrorText, isCanceledError } from './handoffApi'

describe('mutationErrorText', () => {
  it('prefers a CUSTOM_ERROR message written for a human', () => {
    expect(mutationErrorText({ status: 'CUSTOM_ERROR', error: 'Bucket upload failed (500)' })).toBe(
      'Bucket upload failed (500)',
    )
  })

  it('falls back to the message the pipeline sent in the body', () => {
    expect(mutationErrorText({ status: 500, data: { error: 'Storage unavailable' } })).toBe(
      'Storage unavailable',
    )
  })

  it('uses the fallback plus status when there is no message', () => {
    expect(mutationErrorText({ status: 502 })).toBe('Upload failed (502)')
    expect(mutationErrorText({ status: 502 }, 'Import failed')).toBe('Import failed (502)')
  })

  it('uses the bare fallback when there is nothing to go on', () => {
    expect(mutationErrorText(undefined)).toBe('Upload failed')
    expect(mutationErrorText({})).toBe('Upload failed')
  })
})

describe('isCanceledError', () => {
  it('is true only for the tagged cancel error', () => {
    expect(isCanceledError({ status: 'CUSTOM_ERROR', error: 'Upload canceled', data: { canceled: true } })).toBe(true)
    expect(isCanceledError({ status: 'CUSTOM_ERROR', error: 'Upload canceled' })).toBe(false)
    expect(isCanceledError({ status: 500, data: { error: 'nope' } })).toBe(false)
    expect(isCanceledError(undefined)).toBe(false)
  })
})
