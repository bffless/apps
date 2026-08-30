import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const CLIP = join(FIXTURES, 'onboarding-rules.mp4')
const SHA = join(FIXTURES, 'onboarding-rules.sha256')

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
}

export async function ensureClip(override?: string): Promise<{ path: string; sha256: string }> {
  if (override) return { path: override, sha256: '' }
  if (!existsSync(CLIP)) {
    await promisify(execFile)('gh', ['release', 'download', 'workflow-live-fixtures', '--repo', 'bffless/apps', '-p', 'onboarding-rules.mp4', '-D', FIXTURES])
  }
  const pinned = (await readFile(SHA, 'utf8')).trim()
  const actual = await sha256File(CLIP)
  if (actual !== pinned) throw new Error(`fixture clip sha256 mismatch: ${actual} ≠ pinned ${pinned} (${CLIP})`)
  return { path: CLIP, sha256: actual }
}
