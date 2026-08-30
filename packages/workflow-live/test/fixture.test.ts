import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureClip, sha256File } from '../src/fixture.js'

const clip = new URL('../fixtures/onboarding-rules.mp4', import.meta.url)
const sha = new URL('../fixtures/onboarding-rules.sha256', import.meta.url)

describe('ensureClip', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
  const pair = async (content: string, pinned: string): Promise<{ clip: string; sha: string }> => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-live-fixture-'))
    dirs.push(dir)
    const paths = { clip: join(dir, 'clip.mp4'), sha: join(dir, 'clip.sha256') }
    await writeFile(paths.clip, content)
    await writeFile(paths.sha, `${pinned}\n`)
    return paths
  }

  it('returns an override verbatim, unverified', async () => {
    expect((await ensureClip('/x/y.mp4')).path).toBe('/x/y.mp4')
  })
  it('the committed clip is present and matches the pinned sha', async () => {
    expect(existsSync(clip)).toBe(true)
    const pinned = readFileSync(sha, 'utf8').trim()
    expect(await sha256File(fileURLToPath(clip))).toBe(pinned)
    expect((await ensureClip()).sha256).toBe(pinned)
  })
  it('returns the verified path and sha when a pair matches', async () => {
    const paths = await pair('hello', '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    await expect(ensureClip(undefined, paths)).resolves.toEqual({ path: paths.clip, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' })
  })
  it('throws on a sha256 mismatch', async () => {
    const paths = await pair('hello', '0'.repeat(64))
    await expect(ensureClip(undefined, paths)).rejects.toThrow(/fixture clip sha256 mismatch/)
  })
  it('throws when the clip is missing — there is no download fallback', async () => {
    const paths = await pair('hello', '0'.repeat(64))
    await rm(paths.clip)
    await expect(ensureClip(undefined, paths)).rejects.toThrow(/fixture clip missing: .*clip\.mp4 — see fixtures\/README\.md/)
  })
})
