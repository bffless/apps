/**
 * `uploadFile` (06): the prepare → PUT → register flow the kickoff form and
 * the `form` step's file control both drive. Runs against the mock files
 * trio (`src/mocks/handlers.ts`), so this pins the same contract the real
 * rule set answers.
 */
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../mocks/server'
import { putFile, uploadBlob, uploadFile } from './upload'

function file(name = 'photo.png', bytes = 'hello-bytes', type = 'image/png'): File {
  return new File([bytes], name, { type })
}

describe('uploadFile', () => {
  it('prepares, PUTs the bytes with progress, registers, and returns the File ref', async () => {
    const progress: number[] = []

    const ref = await uploadFile({
      impl: 'hello',
      workflow: 'hello',
      scope: 'inputs',
      file: file(),
      onProgress: (f) => progress.push(f),
    })

    expect(ref.name).toBe('photo.png')
    expect(ref.contentType).toBe('image/png')
    // Not asserted byte-exact: msw's XHR interceptor does not forward a
    // File/Blob body faithfully under Node+jsdom (only string/ArrayBuffer
    // bodies survive), so `size` reflects whatever the mock actually stored
    // rather than the real 11 bytes — a test-environment limitation, not a
    // real-browser one (XHR streams a File body correctly there).
    expect(typeof ref.size).toBe('number')
    expect(ref.path).toBe('workflows/hello/hello/inputs/photo.png')
    expect(ref.url).toContain(ref.path.replace(/^workflows\//, ''))
    // jsdom's XHR reports at least the terminal 100% tick.
    expect(progress[progress.length - 1]).toBe(1)
  })

  it('tolerates a prepare response shaped {url,key} instead of {uploadUrl,storageKey}', async () => {
    server.use(
      http.post('/api/workflow/files/prepare', () =>
        HttpResponse.json({ url: '/mock-upload/workflows/hello/hello/inputs/alt.png', key: 'workflows/hello/hello/inputs/alt.png' }),
      ),
    )

    const ref = await uploadFile({ impl: 'hello', workflow: 'hello', scope: 'inputs', file: file('alt.png') })
    expect(ref.path).toBe('workflows/hello/hello/inputs/alt.png')
  })

  it('scopes a step upload under runs/<runId>/<stepKey>', async () => {
    const ref = await uploadFile({
      impl: 'hello',
      workflow: 'hello',
      scope: 'runs/run_1/greet/0/say',
      file: file('take.mov', 'x'.repeat(10), 'video/quicktime'),
    })
    expect(ref.path).toBe('workflows/hello/hello/runs/run_1/greet/0/say/take.mov')
  })

  it('rejects when prepare answers a non-2xx status', async () => {
    server.use(http.post('/api/workflow/files/prepare', () => new HttpResponse(null, { status: 500 })))
    await expect(uploadFile({ impl: 'hello', workflow: 'hello', scope: 'inputs', file: file() })).rejects.toThrow(
      /prepare/,
    )
  })

  it('rejects when the presigned PUT answers a non-2xx status', async () => {
    server.use(http.put('/mock-upload/*', () => new HttpResponse(null, { status: 403 })))
    await expect(uploadFile({ impl: 'hello', workflow: 'hello', scope: 'inputs', file: file() })).rejects.toThrow()
  })

  it('rejects when register answers a non-2xx status', async () => {
    server.use(http.post('/api/workflow/files/register', () => new HttpResponse(null, { status: 500 })))
    await expect(uploadFile({ impl: 'hello', workflow: 'hello', scope: 'inputs', file: file() })).rejects.toThrow(
      /register/,
    )
  })
})

describe('uploadBlob', () => {
  it('prepares, PUTs, registers and returns the File ref for a bare Blob under a step scope', async () => {
    const ref = await uploadBlob({
      impl: 'hello',
      workflow: 'hello',
      scope: 'runs/run_1/bundle/0/zip',
      blob: new Blob(['x'], { type: 'application/zip' }),
      name: 'out.zip',
    })

    expect(ref.name).toBe('out.zip')
    expect(ref.contentType).toBe('application/zip')
    expect(ref.path).toBe('workflows/hello/hello/runs/run_1/bundle/0/zip/out.zip')
  })
})

// M1 minor (task 9 brief): a kickoff upload after an expired session refreshed
// nothing — `prepare`/`register` now go through `httpJsonWithReauth`.
describe('uploadFile — reauth', () => {
  it('refreshes the session once when prepare answers 401, then retries and succeeds', async () => {
    let refreshes = 0
    server.use(
      http.post('/api/workflow/files/prepare', () => new HttpResponse(null, { status: 401 }), { once: true }),
      http.post('/api/auth/session/refresh', () => {
        refreshes += 1
        return new HttpResponse(null, { status: 200 })
      }),
    )

    const ref = await uploadFile({ impl: 'hello', workflow: 'hello', scope: 'inputs', file: file() })

    expect(refreshes).toBe(1)
    expect(ref.name).toBe('photo.png')
  })
})

/**
 * The final whole-branch review (I6): `putFile` is reachable with an
 * already-aborted signal now that a script's Blob outputs upload under the
 * run's abort signal (`scriptLaunch` / the `{"$file"}` offload). Calling
 * `xhr.abort()` on an XHR that was never `send()`-ed fires no `abort` event, so
 * the promise used to hang forever.
 */
describe('putFile', () => {
  it('rejects AbortError, without issuing a PUT, when the signal is already aborted', async () => {
    let puts = 0
    server.use(
      http.put('/mock-upload/*', () => {
        puts += 1
        return new HttpResponse(null, { status: 200 })
      }),
    )

    await expect(
      putFile('/mock-upload/workflows/hello/hello/inputs/x.png', new Blob(['x']), AbortSignal.abort(), undefined),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(puts).toBe(0)
  })
})
