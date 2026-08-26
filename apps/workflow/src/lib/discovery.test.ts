/**
 * apps#363: which project's aliases `discover` probes. `VITE_BFFLESS_PROJECT`
 * is set on the deploy build only (`deploy-workflow.yml`) — unset everywhere
 * else (dev, mocks, CI), which is the unscoped default these tests pin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aliasesUrl, projectRepository } from './discovery'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('projectRepository', () => {
  it('is undefined when VITE_BFFLESS_PROJECT is unset', () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', undefined)
    expect(projectRepository()).toBeUndefined()
  })

  it('is undefined for an empty or whitespace-only value', () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', '   ')
    expect(projectRepository()).toBeUndefined()
  })

  it('reads and trims VITE_BFFLESS_PROJECT', () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', '  bffless/workflow  ')
    expect(projectRepository()).toBe('bffless/workflow')
  })
})

describe('aliasesUrl', () => {
  it('is unscoped when there is no project repository', () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', undefined)
    expect(aliasesUrl()).toBe('api/workflow/aliases')
  })

  it('carries an encoded ?repository= when a project repository is set', () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', 'bffless/workflow')
    expect(aliasesUrl()).toBe('api/workflow/aliases?repository=bffless%2Fworkflow')
  })
})
