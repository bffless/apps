/**
 * `docs/spec/examples/{hello,interactive}.workflow.yaml` are a *copy* of the
 * two YAMLs `bffless/workflow-implementations` publishes at `hello.ref` (Decision 5,
 * "one source") — everything else in this suite (mocks, `rules.fence.test.ts`,
 * the harness build) reads them straight out of `docs/spec/examples/` rather
 * than depending on a staged bundle. This test is the drift check: it fails
 * the moment the pin moves and the copy has not been refreshed, so a stale
 * example can never quietly diverge from what CI actually publishes.
 *
 * Uses `fileURLToPath` + `node:path`, not `new URL(x, import.meta.url)` +
 * `node:fs`'s `URL` overload: under this suite's `jsdom` test environment the
 * two don't reliably agree on `URL` identity (`fs.existsSync` sees `false` for
 * a URL whose own `.href` is the right `file:` path) — plain strings sidestep
 * it, and it's the pattern the rest of the stager already uses
 * (`scripts/stage-hello.mjs`, `hello-stage.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(appDir, 'hello-src', 'hello', '.bffless', 'workflows')
const examples = join(appDir, 'docs', 'spec', 'examples')

describe.skipIf(!existsSync(src))('spec examples mirror bffless/workflow-implementations hello at hello.ref', () => {
  for (const file of ['hello.workflow.yaml', 'interactive.workflow.yaml']) {
    it(file, () => {
      expect(readFileSync(join(examples, file), 'utf8')).toBe(readFileSync(join(src, file), 'utf8'))
    })
  }
})
