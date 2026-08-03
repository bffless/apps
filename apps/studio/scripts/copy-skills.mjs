// Fold the authored AI skills into dist/ so a single artifact (CI deploy or
// catalog bundle) carries everything the pipelines' ai_handler loads.
import { cpSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, '.bffless', 'skills')
const dest = join(root, 'dist', '.bffless', 'skills')

if (!existsSync(src)) {
  console.error(`copy-skills: missing ${src}`)
  process.exit(1)
}
cpSync(src, dest, { recursive: true })
console.log(`copy-skills: ${src} -> ${dest}`)
