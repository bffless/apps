/**
 * The identity file (apps#420, plan Decision 6:
 * docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:22) —
 * `.bffless/workflow.json`, `{ alias, harness }`. It's the one place an
 * implementation states its own alias and which harness alias it deploys
 * under; `renamePass` (src/rewrite.ts) treats it as an ordinary text file in
 * its boundary-aware pass (its content is just `"alias": "<token>"`, so the
 * same regex that rewrites everything else rewrites this too), while
 * `init`/`add` (Tasks 4–5) write a fresh one directly through
 * `writeIdentity`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Identity {
  alias: string
  harness: string
}

const IDENTITY_REL_PATH = '.bffless/workflow.json'

/** Reads `<dir>/.bffless/workflow.json`. Throws if missing or malformed. */
export function readIdentity(dir: string): Identity {
  const file = join(dir, IDENTITY_REL_PATH)
  const raw = readFileSync(file, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`, { cause: e })
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).alias !== 'string' ||
    typeof (parsed as Record<string, unknown>).harness !== 'string'
  ) {
    throw new Error(`${file}: not a valid identity file — expected { "alias": string, "harness": string }`)
  }
  const { alias, harness } = parsed as Identity
  return { alias, harness }
}

/**
 * Writes `<dir>/.bffless/workflow.json`. The exact single-line `{ "alias":
 * …, "harness": … }` style (not pretty-printed JSON.stringify output)
 * matches every hand-authored identity file in `workflow-implementations`,
 * so a fresh write from `init` reads the same as the fixtures it's modeled
 * on.
 */
export function writeIdentity(dir: string, id: Identity): void {
  const file = join(dir, IDENTITY_REL_PATH)
  writeFileSync(file, `{ "alias": ${JSON.stringify(id.alias)}, "harness": ${JSON.stringify(id.harness)} }\n`)
}
