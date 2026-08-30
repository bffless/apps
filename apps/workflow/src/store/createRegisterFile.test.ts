import { describe, expect, it } from 'vitest'
import type { HttpJson } from '../lib/runner/adapters/pipeline'
import { RegisterFileError } from '../lib/runner/registerRetry'
import { createRegisterFile } from './runnerMiddleware'
import type { RunState } from '../lib/runner/types'

const state = { impl: 'workflow-studio', workflow: 'studio', runId: 'run_1' } as unknown as RunState

describe('createRegisterFile', () => {
  it('throws a RegisterFileError carrying the status and naming the path when files/register does not answer 2xx', async () => {
    const http: HttpJson = async () => ({ status: 500, ok: false, body: { error: 'boom' } })
    const register = createRegisterFile(http)
    const err = await register(state, 'blog/0/frames', 'workflows/x/frame-159.jpg').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RegisterFileError)
    expect((err as RegisterFileError).status).toBe(500)
    expect((err as RegisterFileError).path).toBe('workflows/x/frame-159.jpg')
    expect((err as Error).message).toBe('registerFile workflows/x/frame-159.jpg: files/register answered 500')
  })
})
