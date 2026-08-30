import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const CLIP = join(FIXTURES, 'onboarding-rules.mp4')
const SHA = join(FIXTURES, 'onboarding-rules.sha256')

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
}

export interface FixturePaths { clip: string; sha: string }

/**
 * The committed clip is the only source: there is no download fallback (the
 * `workflow-live-fixtures` release was never made — see fixtures/README.md).
 * A missing or tampered clip throws; the walk turns that into `BLOCKED`.
 * `paths` exists so the throws can be tested against a temp file pair.
 */
export async function ensureClip(override?: string, paths: FixturePaths = { clip: CLIP, sha: SHA }): Promise<{ path: string; sha256: string }> {
  if (override) return { path: override, sha256: '' }
  if (!existsSync(paths.clip)) throw new Error(`fixture clip missing: ${paths.clip} — see fixtures/README.md`)
  const pinned = (await readFile(paths.sha, 'utf8')).trim()
  const actual = await sha256File(paths.clip)
  if (actual !== pinned) throw new Error(`fixture clip sha256 mismatch: ${actual} ≠ pinned ${pinned} (${paths.clip})`)
  return { path: paths.clip, sha256: actual }
}
