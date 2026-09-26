/**
 * `attemptRefresh` is the one refresh the whole app shares (apps#707): the
 * read path (`store/workflowApi.ts`) and the write path (`lib/http.ts`) both
 * ride it. The consumers' own suites pin the retry policy around it; this one
 * pins the promise's lifecycle.
 */
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../mocks/server'
import { attemptRefresh } from './auth'

describe('attemptRefresh', () => {
  it('shares one in-flight refresh between concurrent callers', async () => {
    let refreshes = 0
    server.use(
      http.post('/api/auth/session/refresh', () => {
        refreshes += 1
        return new HttpResponse(null, { status: 200 })
      }),
    )

    const outcomes = await Promise.all([attemptRefresh(), attemptRefresh(), attemptRefresh()])

    expect(refreshes).toBe(1)
    expect(outcomes).toEqual([true, true, true])
  })

  it('clears the slot after a failed attempt, so the next 401 starts a fresh one', async () => {
    // A latched failure would make a re-login mid-run need a page reload:
    // every later 401 would reuse the stale `false` instead of trying again.
    let refreshes = 0
    server.use(
      http.post('/api/auth/session/refresh', () => {
        refreshes += 1
        return new HttpResponse(null, { status: refreshes === 1 ? 401 : 200 })
      }),
    )

    expect(await attemptRefresh()).toBe(false)
    expect(await attemptRefresh()).toBe(true)
    expect(refreshes).toBe(2)
  })

  it('answers false, not a rejection, when the refresh request itself throws', async () => {
    server.use(http.post('/api/auth/session/refresh', () => HttpResponse.error()))

    await expect(attemptRefresh()).resolves.toBe(false)
  })
})
