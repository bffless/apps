/**
 * The stager, end to end: `scripts/stage.mjs` type-checks, builds the island and the
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

      // The cut editor is the only island, listed at the path `studio.workflow.yaml`'s
      // `island` step names (`src: islands/cut-editor.html`).
      expect(index.islands).toEqual(['islands/cut-editor.html'])
      expect(existsSync(join(out, 'islands/cut-editor.html'))).toBe(true)

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
        // fail at run time, and a sibling chunk would never be fetched at all.
        expect(code).not.toMatch(/(^|[\s;}])import\s*[({'"*]/)
        expect(code).not.toMatch(/(^|[\s;}])from\s*['"]/)
        expect(code).not.toMatch(/[^\w.]require\s*\(/)
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
