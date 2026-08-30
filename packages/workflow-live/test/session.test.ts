import { describe, expect, it } from 'vitest'
import { classify, redactUrl } from '../src/session.js'

describe('classify', () => {
  it('spots a successful register', () => {
    expect(classify('https://w/api/workflow/files/register', 'POST', 200, false)).toEqual({ kind: 'register' })
    expect(classify('https://w/api/workflow/files/register', 'POST', 500, false)).toEqual({ kind: 'other' })
  })
  it('spots a session (not API-key) delete', () => {
    expect(classify('https://w/api/workflow/run/delete', 'POST', 200, false)).toEqual({ kind: 'delete' })
    expect(classify('https://w/api/workflow/run/delete', 'POST', 403, true)).toEqual({ kind: 'other' })
  })
  it('matches on the pathname, so a query string does not hide either shape', () => {
    expect(classify('https://w/api/workflow/files/register?x=1', 'POST', 200, false)).toEqual({ kind: 'register' })
    expect(classify('https://w/api/workflow/run/delete?x=1', 'POST', 200, false)).toEqual({ kind: 'delete' })
  })
  it('requires POST for both shapes', () => {
    expect(classify('https://w/api/workflow/files/register', 'GET', 200, false)).toEqual({ kind: 'other' })
    expect(classify('https://w/api/workflow/run/delete', 'GET', 200, false)).toEqual({ kind: 'other' })
  })
})

describe('redactUrl', () => {
  it('blanks a presigned signature and keeps the path and other params', () => {
    const url = 'https://storage.googleapis.com/bucket/w/hello/run-1/poster.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=abc123&Expires=1700000000'
    expect(redactUrl(url)).toBe('https://storage.googleapis.com/bucket/w/hello/run-1/poster.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=…&Expires=1700000000')
  })
  it('blanks every credential-bearing parameter of an S3 presigned URL', () => {
    const url = 'https://b.s3.amazonaws.com/k.png?X-Amz-Credential=AKIA%2F20260830&X-Amz-Date=20260830T000000Z&X-Amz-Signature=deadbeef'
    expect(redactUrl(url)).toBe('https://b.s3.amazonaws.com/k.png?X-Amz-Credential=…&X-Amz-Date=20260830T000000Z&X-Amz-Signature=…')
  })
  it('blanks only token on a share link', () => {
    expect(redactUrl('https://w/r/abc/poster.png?token=s3cr3t&download=1')).toBe('https://w/r/abc/poster.png?token=…&download=1')
  })
  it('returns a query-less URL unchanged', () => {
    expect(redactUrl('https://w/api/workflow/whoami')).toBe('https://w/api/workflow/whoami')
  })
  it('leaves the D8 discovery calls verbatim', () => {
    expect(redactUrl('https://w/api/workflow/aliases?repository=bffless%2Fworkflow')).toBe('https://w/api/workflow/aliases?repository=bffless%2Fworkflow')
  })
  it('does not touch a fragment', () => {
    expect(redactUrl('https://w/x?sig=abc#frag')).toBe('https://w/x?sig=…#frag')
  })
})
