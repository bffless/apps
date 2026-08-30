import { describe, expect, it } from 'vitest'
import { classify } from '../src/session.js'

describe('classify', () => {
  it('spots a successful register', () => {
    expect(classify('https://w/api/workflow/files/register', 'POST', 200, false)).toEqual({ kind: 'register' })
    expect(classify('https://w/api/workflow/files/register', 'POST', 500, false)).toEqual({ kind: 'other' })
  })
  it('spots a session (not API-key) delete', () => {
    expect(classify('https://w/api/workflow/run/delete', 'POST', 200, false)).toEqual({ kind: 'delete' })
    expect(classify('https://w/api/workflow/run/delete', 'POST', 403, true)).toEqual({ kind: 'other' })
  })
})
