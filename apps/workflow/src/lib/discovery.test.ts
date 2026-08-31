/**
 * apps#363: which project's aliases `discover` probes. Since M4, discovery is
 * runtime-first: the harness asks its own serving rule set
 * (`GET /api/workflow/project`, the `deployment` provenance root) and
 * `VITE_BFFLESS_PROJECT` is only an *override* — set on the deploy build
 * (`deploy-workflow.yml`) to save the one request and pin CI deploys
 * explicitly, unset everywhere else (dev, mocks, CI).
 */
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '../mocks/server'
import { aliasesUrl, fetchProjectRepository, projectRepository } from './discovery'

/** Answer `GET /api/workflow/project` with `body`, counting the calls made. */
function projectEndpoint(body: { repository: string | null }): { calls: () => number } {
  let calls = 0
  server.use(
    http.get('/api/workflow/project', () => {
      calls += 1
      return HttpResponse.json(body)
    }),
  )
  return { calls: () => calls }
}

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

describe('fetchProjectRepository', () => {
  it('prefers the VITE_BFFLESS_PROJECT override — no request is made', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', 'bffless/workflow')
    const endpoint = projectEndpoint({ repository: 'other/project' })

    await expect(fetchProjectRepository()).resolves.toBe('bffless/workflow')
    expect(endpoint.calls()).toBe(0)
  })

  it('asks the serving rule set when the env is unset', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', undefined)
    projectEndpoint({ repository: 'o/r' })

    await expect(fetchProjectRepository()).resolves.toBe('o/r')
  })

  it('answers undefined for a null repository (provenance absent)', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', undefined)
    projectEndpoint({ repository: null })

    await expect(fetchProjectRepository()).resolves.toBeUndefined()
  })

  it('answers undefined when the endpoint itself fails', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', undefined)
    server.use(
      http.get('/api/workflow/project', () => new HttpResponse(null, { status: 500 })),
    )

    await expect(fetchProjectRepository()).resolves.toBeUndefined()
  })

  it('fetches once and caches the answer for the session', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', undefined)
    const endpoint = projectEndpoint({ repository: 'o/r' })

    await expect(fetchProjectRepository()).resolves.toBe('o/r')
    await expect(fetchProjectRepository()).resolves.toBe('o/r')
    expect(endpoint.calls()).toBe(1)
  })
})

describe('aliasesUrl', () => {
  it('carries an encoded ?repository= from the env override, with no request made', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', 'bffless/workflow')
    const endpoint = projectEndpoint({ repository: 'other/project' })

    await expect(aliasesUrl()).resolves.toBe('api/workflow/aliases?repository=bffless%2Fworkflow')
    expect(endpoint.calls()).toBe(0)
  })

  it('carries an encoded ?repository= from the runtime answer when the env is unset', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', undefined)
    projectEndpoint({ repository: 'o/r' })

    await expect(aliasesUrl()).resolves.toBe('api/workflow/aliases?repository=o%2Fr')
  })

  it('is unscoped when the endpoint answers a null repository', async () => {
    // Today's fallback, preserved on purpose: the unscoped list is what an
    // instance with no provenance gets, and ce#702 made that list role-scoped
    // server-side, so falling back open leaks nothing.
    vi.stubEnv('VITE_BFFLESS_PROJECT', undefined)
    projectEndpoint({ repository: null })

    await expect(aliasesUrl()).resolves.toBe('api/workflow/aliases')
  })
})
