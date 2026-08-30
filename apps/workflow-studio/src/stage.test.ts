/**
 * The stager, end to end: `scripts/stage.mjs` type-checks, builds the islands and the
 * five script modules, and then has `workflow index` write the bundle's
 * `.bffless/workflows/index.json`.
 *
 * This is the one suite that runs a REAL build (a `tsc` pass, one Vite island build and
 * five Vite script builds — tens of seconds), which is why it lives in its own `stage`
 * vitest project under `src/` rather than in `scripts/` or `islands/`: those two projects
 * are type-checked as browser/Worker code (`tsconfig.scripts.json`, `tsconfig.islands.json`)
 * and this file is Node tooling (`tsconfig.node.json`, alongside the Vite configs it drives).
 *
 * It builds into a temp directory, so it never clobbers the `dist/` that
 * `scripts/build.test.ts` and `islands/cut-editor/build.test.ts` read — those two assert
 * only when CI has run `stage` first (that ordering is what makes them assert at all).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The five `script` entries `studio.workflow.yaml` names, sorted as the index lists them. */
const SCRIPT_NAMES = ['blog-bundle', 'final-script', 'frame-times', 'scene-inputs', 'sheet-plan']

/**
 * The skills the rules enable, sorted: `thumbnail/draft` → `image-prompts`, `describe` →
 * `video-description`, `blog` → `bffless-docs` (each rule's `skills.enabled`).
 */
const SKILL_NAMES = ['bffless-docs', 'image-prompts', 'video-description']

/** A real build of six Vite entries plus a project-wide `tsc` — minutes, not milliseconds. */
const BUILD_TIMEOUT = 600_000

/**
 * Blanks every string/template literal so the no-import assertions match module SYNTAX
 * only: a bundled literal containing "\nimport {" (an error message, a code template) is
 * data and must not trip the guard, while a real leftover import still matches — its
 * specifier just collapses to `""`. The exact expression `scripts/stage.mjs` and
 * `scripts/build.test.ts` apply; the fence test below keeps the three copies identical.
 */
const STRIP_LITERALS = /'(?:[^'\\\n]|\\[\s\S])*'|"(?:[^"\\\n]|\\[\s\S])*"|`(?:[^`\\]|\\[\s\S])*`/g
const stripLiterals = (code: string): string => code.replace(STRIP_LITERALS, '""')

const outDirs: string[] = []

function tmpOut(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-studio-stage-test-'))
  outDirs.push(dir)
  return dir
}

function stage(...args: string[]): void {
  execFileSync('node', ['scripts/stage.mjs', ...args], { cwd: appDir, stdio: 'inherit' })
}

afterEach(() => {
  while (outDirs.length > 0) rmSync(outDirs.pop()!, { recursive: true, force: true })
})

describe('scripts/stage.mjs', () => {
  it(
    'stages a self-contained bundle the harness can read',
    () => {
      const out = tmpOut()
      stage('--out', out)

      const index = JSON.parse(readFileSync(join(out, '.bffless/workflows/index.json'), 'utf8'))

      expect(index.impl).toBe('workflow-studio')
      expect(index.name).toBe('Studio')
      expect(index.description).toBeTruthy()

      // One workflow, and `workflow index` only writes an index at all when it lints clean.
      expect(index.workflows).toHaveLength(1)
      expect(index.workflows[0].file).toBe('studio.workflow.yaml')

      // Both islands, listed at the paths `studio.workflow.yaml`'s `island` steps name
      // (`src: islands/cut-editor.html`, `src: islands/blog-editor.html`).
      expect(index.islands).toEqual(['islands/blog-editor.html', 'islands/cut-editor.html'])
      expect(existsSync(join(out, 'islands/cut-editor.html'))).toBe(true)
      expect(existsSync(join(out, 'islands/blog-editor.html'))).toBe(true)

      // …and all five scripts, at the paths the `script` steps name.
      expect(index.scripts).toEqual(SCRIPT_NAMES.map((name) => `scripts/${name}.js`))

      // The skills the rule set's `ai_handler` steps name (`skills.path:
      // apps/workflow-studio/dist/.bffless/skills`, `enabled: [<name>]`) ship inside the
      // bundle, one `<name>/SKILL.md` each — CE lists a skill by exactly that file.
      for (const name of SKILL_NAMES) {
        expect(existsSync(join(out, '.bffless/skills', name, 'SKILL.md'))).toBe(true)
      }

      for (const name of SCRIPT_NAMES) {
        const code = readFileSync(join(out, 'scripts', `${name}.js`), 'utf8')
        // A script is fetched as text and run in a Worker spawned from a `data:` URL
        // (spec 03/09): a surviving `import` would resolve against an opaque origin and
        // fail at run time, and a sibling chunk would never be fetched at all. Literals
        // are blanked first so a bundled string mentioning `import` is not a match.
        const syntax = stripLiterals(code)
        expect(syntax).not.toMatch(/(^|[\s;}])import\s*[({'"*]/)
        expect(syntax).not.toMatch(/(^|[\s;}])from\s*['"]/)
        expect(syntax).not.toMatch(/[^\w.]require\s*\(/)
      }
    },
    BUILD_TIMEOUT,
  )

  it(
    'publishes the --impl/--name it is given, not the defaults',
    () => {
      const out = tmpOut()
      stage('--out', out, '--impl', 'workflow-studio-pr-7', '--name', 'Studio (PR #7)')

      const index = JSON.parse(readFileSync(join(out, '.bffless/workflows/index.json'), 'utf8'))
      expect(index.impl).toBe('workflow-studio-pr-7')
      expect(index.name).toBe('Studio (PR #7)')
    },
    BUILD_TIMEOUT,
  )

  it('refuses to stage into a directory that is not a bundle', () => {
    const out = tmpOut()
    // Something that is plainly not ours: clearing it would be data loss.
    writeFileSync(join(out, 'notes.txt'), 'not a bundle')

    expect(() => stage('--out', out)).toThrow()
    expect(existsSync(join(out, 'notes.txt'))).toBe(true)
  })

  it('rejects a flag with no value', () => {
    expect(() => stage('--out')).toThrow()
  })
})

describe('the no-import guard', () => {
  const IMPORT = /(^|[\s;}])import\s*[({'"*]/
  const FROM = /(^|[\s;}])from\s*['"]/
  const REQUIRE = /[^\w.]require\s*\(/

  it('ignores import/from/require inside bundled string literals (#463)', () => {
    // Each of these is DATA a legitimate bundle can carry — an error message, a code
    // template — and each matched the raw regexes before literals were blanked first.
    for (const bundled of [
      'const tpl = `\nimport { cut } from "./editor"\n`;',
      'const msg = "did you mean to import {...}?";',
      'const hint = \'ported from "studio"\';',
      'const doc = "call require(...) at the top";',
    ]) {
      const syntax = stripLiterals(bundled)
      expect(syntax).not.toMatch(IMPORT)
      expect(syntax).not.toMatch(FROM)
      expect(syntax).not.toMatch(REQUIRE)
    }
  })

  it('still catches real static imports, dynamic import() and require()', () => {
    expect(stripLiterals('import { x } from "./x.js";')).toMatch(IMPORT)
    expect(stripLiterals('const m = await import("./m.js");')).toMatch(IMPORT)
    expect(stripLiterals('} from "./chunk-abc.js";')).toMatch(FROM)
    expect(stripLiterals('const m = require("./m.js");')).toMatch(REQUIRE)
  })

  it('is the exact expression scripts/stage.mjs and scripts/build.test.ts apply', () => {
    for (const file of ['scripts/stage.mjs', 'scripts/build.test.ts']) {
      expect(readFileSync(join(appDir, file), 'utf8')).toContain(STRIP_LITERALS.source)
    }
  })
})
