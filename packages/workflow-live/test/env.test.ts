import { describe, expect, it } from 'vitest'
import { adminKey, credentials } from '../src/env.js'

describe('credentials', () => {
  it('prefers the driver names', () => {
    expect(credentials({ WORKFLOW_EMAIL: 'a', WORKFLOW_PASSWORD: 'b', WORKFLOW_CI_EMAIL: 'x', WORKFLOW_CI_PASSWORD: 'y' })).toEqual({ email: 'a', password: 'b' })
  })
  it('accepts the workflow-ci.env aliases', () => {
    expect(credentials({ WORKFLOW_CI_EMAIL: 'x', WORKFLOW_CI_PASSWORD: 'y' })).toEqual({ email: 'x', password: 'y' })
  })
  it('is undefined when either half is missing', () => {
    expect(credentials({ WORKFLOW_EMAIL: 'a' })).toBeUndefined()
    expect(credentials({})).toBeUndefined()
  })
  it('falls back on empty string via CI aliases', () => {
    expect(credentials({ WORKFLOW_EMAIL: '', WORKFLOW_PASSWORD: '', WORKFLOW_CI_EMAIL: 'x', WORKFLOW_CI_PASSWORD: 'y' })).toEqual({ email: 'x', password: 'y' })
  })
  it('adminKey is optional', () => {
    expect(adminKey({})).toBeUndefined()
    expect(adminKey({ ADMIN_API_KEY: 'k' })).toBe('k')
  })
})
