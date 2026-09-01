/**
 * The boundary-aware rename engine (apps#420, plan Decision 6:
 * docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:22).
 *
 * An implementation's alias shows up in a long-tailed set of places —
 * hello's own inventory: the identity file, the rule-set directory name,
 * `ruleset.yaml`'s `name:`/description, `$schema:<alias>_*` schema names,
 * their `schemaId:` refs AND their FILENAMES (`<alias>_*.schema.yaml`),
 * `package.json`'s `name` + `rules:validate` path, `scripts/build.mjs`'s
 * `--impl` default and rule-set path/prefix strings, README prose — and an
 * arbitrary `--from` source (Task 4) can add more that were never
 * enumerated here. So this is *validated*, not *enumerated*: three
 * structural moves (the rule-set directory; any file whose BASENAME starts
 * with `<oldAlias>_`, e.g. `hello_jobs.schema.yaml` — the `bffless` CLI
 * resolves a `$schema:<name>` ref to `schemas/<name>.schema.yaml` BY
 * FILENAME (a live-proven bug, apps#420: a stale basename after rename
 * breaks `rules push` even though the ref and the file's own `name:` were
 * both already rewritten by the textual pass — so **schema filenames ARE
 * identity**, general on any `<oldAlias>_`-prefixed basename rather than
 * scoped to `*.schema.yaml`, since the rule is exactly as simple either way
 * and schema files are merely the only known case in practice; the identity
 * file's content, which the textual pass below handles like any other text
 * file), plus one textual pass applied uniformly to every non-binary,
 * non-vendored file in the tree.
 *
 * The textual pass replaces `oldAlias` wherever it is not immediately
 * adjacent to `[a-z0-9]` on either side — hyphen and underscore *are*
 * boundaries, so alias-derived tokens like `hello-pr-1` and `hello_jobs` are
 * rewritten, while `othello`/`shellhello` (where `hello` sits next to a
 * letter) are left alone. One regex covers every row of the inventory above
 * without special-casing any of them: `hello_jobs` -> `studio_jobs` and
 * `workflow-hello` -> `workflow-studio` fall out of the same rule that
 * protects `othello`.
 *
 * Workflow filenames (`.bffless/workflows/*.workflow.yaml`) are explicitly
 * NOT identity (Decision 6) — their names are left exactly as they are;
 * only their text content goes through the same textual pass as everything
 * else. (They don't start with `<alias>_` either, so the new basename move
 * above never touches them.)
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

/**
 * Ported verbatim from `bffless/publish-workflow` `scripts/prepare-rules.mjs`
 * (fetched read-only, not re-typed from memory — as of the commit this was
 * ported from: `RESERVED_ALIASES` at line 20, `ALIAS_RE` at line 23). Must
 * stay byte-equal: `workflow rename`/`init` validate against the exact same
 * rules the publish action enforces at sync time, so a rename that looks
 * valid here can never be rejected later by `prepare-rules.mjs`.
 */
export const RESERVED_ALIASES = ['workflow', 'w', 'auth', '_bffless']
export const ALIAS_RE = /^[a-z][a-z0-9-]*$/

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git'])

export interface RenameReport {
  renames: [string, string][]
  edits: { file: string; count: number }[]
}

export interface RenameOptions {
  dryRun?: boolean
}

/** Same validation, same messages, as `prepare-rules.mjs` — see the module doc above. */
function assertValidAlias(alias: string): void {
  if (RESERVED_ALIASES.includes(alias)) {
    throw new Error(`alias "${alias}" is reserved (${RESERVED_ALIASES.join(', ')})`)
  }
  if (!ALIAS_RE.test(alias)) {
    throw new Error(`alias "${alias}" is not a valid alias: expected ${ALIAS_RE}`)
  }
}

/** `token`, matched only where neither neighbor is `[a-z0-9]` — see the module doc above. */
function boundaryPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'g')
}

/** A NUL byte in the first 8000 bytes — the same heuristic git's own binary sniff uses. */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/** Every file under `root`, skipping `SKIP_DIRS`, as absolute paths. */
function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(resolve(dir, entry.name))
      } else if (entry.isFile()) {
        out.push(resolve(dir, entry.name))
      }
    }
  }
  walk(root)
  return out
}

/**
 * Renames `oldAlias` to `newAlias` throughout the implementation rooted at
 * `dir`: the `.bffless/proxy-rules/<oldAlias>/` directory (if present)
 * structurally, then every non-binary, non-vendored file's text content via
 * the boundary rule described in the module doc.
 *
 * `dryRun: true` computes and returns the identical report with zero
 * filesystem writes — the report always describes the tree's shape *after*
 * the rename, whether or not anything was actually written, so a dry run and
 * a real run on the same starting tree produce deep-equal reports.
 *
 * Throws before touching the filesystem if `newAlias` is reserved or
 * doesn't match `ALIAS_RE`.
 */
export function renamePass(
  dir: string,
  oldAlias: string,
  newAlias: string,
  options: RenameOptions = {},
): RenameReport {
  assertValidAlias(newAlias)
  const dryRun = options.dryRun ?? false
  const root = resolve(dir)

  const renames: [string, string][] = []
  const oldRuleSetDir = resolve(root, '.bffless', 'proxy-rules', oldAlias)
  const newRuleSetDir = resolve(root, '.bffless', 'proxy-rules', newAlias)
  const oldRuleSetRel = toPosix(relative(root, oldRuleSetDir))
  const newRuleSetRel = toPosix(relative(root, newRuleSetDir))
  const hasRuleSetDir = existsSync(oldRuleSetDir) && statSync(oldRuleSetDir).isDirectory()

  if (hasRuleSetDir) {
    renames.push([oldRuleSetRel, newRuleSetRel])
    if (!dryRun) renameSync(oldRuleSetDir, newRuleSetDir)
  }

  // Directory-only remap (structural move 1). In a real run the directory is
  // already renamed on disk by the time we get here, so this is a no-op
  // remap; in a dry run the directory is still at its old path on disk, so
  // the old prefix is rewritten to the new one for reporting purposes only.
  const dirReportedPath = (actualRel: string): string => {
    if (!hasRuleSetDir) return actualRel
    if (actualRel === oldRuleSetRel) return newRuleSetRel
    if (actualRel.startsWith(`${oldRuleSetRel}/`)) return newRuleSetRel + actualRel.slice(oldRuleSetRel.length)
    return actualRel
  }

  // Basename remap (structural move 2 — schema filenames, see module doc).
  // Applied to a path whose DIRECTORY portion is already fully resolved
  // (post structural move 1): if the basename currently starts with
  // `<oldAlias>_`, it's rewritten to start with `<newAlias>_`; a basename
  // that's already renamed (real run, second call below) or was never
  // prefixed at all just passes through unchanged — same "either state
  // converges on the same reported value" trick `dirReportedPath` relies on.
  const basenamePrefix = `${oldAlias}_`
  const basenameReportedPath = (relPath: string): string => {
    const idx = relPath.lastIndexOf('/')
    const dirPart = idx === -1 ? '' : relPath.slice(0, idx + 1)
    const base = idx === -1 ? relPath : relPath.slice(idx + 1)
    if (!base.startsWith(basenamePrefix)) return relPath
    return `${dirPart}${newAlias}_${base.slice(basenamePrefix.length)}`
  }

  // Structural move 2, applied: scanned once (directory move already applied
  // on disk for a real run, so this sees the post-move-1 tree either way —
  // see dirReportedPath's own comment), sorted for a deterministic report
  // (`readdirSync` order isn't guaranteed), then physically renamed.
  const schemaRenames = listFiles(root)
    .map((actual) => dirReportedPath(toPosix(relative(root, actual))))
    .filter((dirRel) => {
      const idx = dirRel.lastIndexOf('/')
      const base = idx === -1 ? dirRel : dirRel.slice(idx + 1)
      return base.startsWith(basenamePrefix)
    })
    .sort()
    .map((dirRel): [string, string] => [dirRel, basenameReportedPath(dirRel)])

  for (const [fromRel, toRel] of schemaRenames) {
    renames.push([fromRel, toRel])
    if (!dryRun) renameSync(resolve(root, fromRel), resolve(root, toRel))
  }

  const reportedPath = (actualRel: string): string => basenameReportedPath(dirReportedPath(actualRel))

  const items = listFiles(root)
    .map((actual) => ({ actual, reported: reportedPath(toPosix(relative(root, actual))) }))
    // Sorted by the reported (post-rename) path, not the raw disk path, so a
    // dry run and a real run — which walk physically different directory
    // names for the same logical files — still enumerate in the same order.
    .sort((a, b) => (a.reported < b.reported ? -1 : a.reported > b.reported ? 1 : 0))

  const edits: { file: string; count: number }[] = []
  const pattern = boundaryPattern(oldAlias)

  for (const { actual, reported } of items) {
    const buf = readFileSync(actual)
    if (looksBinary(buf)) continue

    const content = buf.toString('utf8')
    const count = [...content.matchAll(pattern)].length
    if (count === 0) continue

    edits.push({ file: reported, count })
    if (!dryRun) writeFileSync(actual, content.replace(pattern, newAlias))
  }

  return { renames, edits }
}
