// Fold the authored AI skills into dist/ so a single artifact (CI deploy or
// catalog bundle) carries everything the pipelines' ai_handler loads.
//
// The destination is deliberately NOT a hidden directory (dist/bffless/skills,
// not dist/.bffless/skills): CE's createDeploymentFromZip skips any zip entry
// whose path includes('/.') (nested hidden dirs — the top-level .bffless/
// exception doesn't apply once basePath re-keys everything under
// apps/studio/dist/...), so a hidden path here would be silently stripped
// from catalog install bundles.
import { cpSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, '.bffless', 'skills')
const dest = join(root, 'dist', 'bffless', 'skills')

if (!existsSync(src)) {
  console.error(`copy-skills: missing ${src}`)
  process.exit(1)
}
cpSync(src, dest, { recursive: true })
console.log(`copy-skills: ${src} -> ${dest}`)
