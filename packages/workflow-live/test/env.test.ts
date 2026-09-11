import { describe, expect, it } from 'vitest'
import { adminKey, appToken, credentials, secondAppToken, secondCredentials } from '../src/env.js'

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
  it('appToken is optional and ignores the empty string', () => {
    expect(appToken({})).toBeUndefined()
    expect(appToken({ WORKFLOW_APP_TOKEN: '' })).toBeUndefined()
    expect(appToken({ WORKFLOW_APP_TOKEN: 'bfat_x' })).toBe('bfat_x')
  })
})

describe('secondCredentials', () => {
  it('reads WORKFLOW_EMAIL_2 / WORKFLOW_PASSWORD_2', () => {
    expect(secondCredentials({ WORKFLOW_EMAIL_2: 'b@x.test', WORKFLOW_PASSWORD_2: 'pw' })).toEqual({ email: 'b@x.test', password: 'pw' })
  })
  it('is undefined when either half is missing', () => {
    expect(secondCredentials({ WORKFLOW_EMAIL_2: 'b@x.test' })).toBeUndefined()
    expect(secondCredentials({})).toBeUndefined()
  })
  it('has no CI alias — unlike credentials, a person-created prerequisite has none to fall back on', () => {
    expect(secondCredentials({ WORKFLOW_CI_EMAIL: 'x', WORKFLOW_CI_PASSWORD: 'y' })).toBeUndefined()
  })
  it('falls back on empty string to undefined', () => {
    expect(secondCredentials({ WORKFLOW_EMAIL_2: '', WORKFLOW_PASSWORD_2: '' })).toBeUndefined()
  })
})

describe('secondAppToken', () => {
  it('is optional and ignores the empty string', () => {
    expect(secondAppToken({})).toBeUndefined()
    expect(secondAppToken({ WORKFLOW_APP_TOKEN_2: '' })).toBeUndefined()
    expect(secondAppToken({ WORKFLOW_APP_TOKEN_2: 'bfat_y' })).toBe('bfat_y')
  })
})
