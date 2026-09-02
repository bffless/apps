// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { originOf, uiMeta } from './csp'

describe('uiMeta', () => {
  it('lists the app domain and the storage origin, derived', () => {
    expect(uiMeta('https://workflow-mcp.j5s.dev', 'https://storage.googleapis.com')).toEqual({
      ui: {
        csp: {
          connectDomains: ['https://workflow-mcp.j5s.dev', 'https://storage.googleapis.com'],
          resourceDomains: ['https://storage.googleapis.com'],
        },
        prefersBorder: true,
      },
    })
  })

  it('omits an unknown storage origin rather than inventing one', () => {
    expect(uiMeta('https://h', '').ui.csp).toEqual({ connectDomains: ['https://h'], resourceDomains: [] })
  })
})

describe('originOf', () => {
  it('takes the origin of a presigned URL', () => {
    expect(originOf('https://storage.googleapis.com/j5s-dev/x?X-Goog-Algorithm=1')).toBe('https://storage.googleapis.com')
    expect(originOf('http://minio:9000/bucket/key')).toBe('http://minio:9000')
  })
  it('is empty for a relative or missing URL', () => {
    expect(originOf('/api/storage/presigned/local?key=x')).toBe('')
    expect(originOf(undefined)).toBe('')
  })
})
