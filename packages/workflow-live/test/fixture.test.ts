import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ensureClip, sha256File } from '../src/fixture.js'

describe('ensureClip', () => {
  it('returns an override verbatim, unverified', async () => {
    expect((await ensureClip('/x/y.mp4')).path).toBe('/x/y.mp4')
  })
  it('the pinned sha matches the committed clip when it is present', async () => {
    const clip = new URL('../fixtures/onboarding-rules.mp4', import.meta.url)
    if (!existsSync(clip)) return   // release-asset variant: nothing to verify offline
    const pinned = readFileSync(new URL('../fixtures/onboarding-rules.sha256', import.meta.url), 'utf8').trim()
    expect(await sha256File(fileURLToPath(clip))).toBe(pinned)
  })
})
