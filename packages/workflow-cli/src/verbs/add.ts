/**
 * `workflow add <name> [--step <path>]…` (apps#420, plan Decision 11:
 * docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:27). Scaffolds
 * a new `.bffless/workflows/<name>.workflow.yaml` — one job (id `<name>`),
 * one `uses: pipeline` step per `--step <path>` (defaulting to a single step
 * whose path is `<name>` when `--step` is omitted) — plus, per step path, a
 * matching rule stub under the implementation's own rule set:
 * `rules/<path>/post/{rule.yaml,<segment>.fn.js,<segment>.fn.test.yaml}`,
 * `<segment>` being the path's last slash-separated component. The pairing
 * is deliberate: workflow-lint's `rule-missing` check (06,
 * packages/workflow-lint/src/checks/rules.ts) resolves a relative
 * `with.path` against exactly this directory shape, so `workflow lint`
 * reports zero `rule-missing` findings immediately after `add` — no
 * hand-authoring required before the first lint.
 *
 * `add` runs inside an already-`init`ed implementation directory: the alias
 * (and therefore the rule-set directory, `.bffless/proxy-rules/<alias>/`) is
 * read from the identity file (../identity.ts), never passed as a flag.
 *
 * The rule stub's shape (`pipeline` → `function_handler` calling a sibling
 * `<segment>.fn.js` → `response_handler` echoing its result, one
 * `auth_required` validator) is ported from hello's `echo`/`slow` rules
 * (fetched read-only from `bffless/workflow-implementations` — the smallest
 * real rule.yaml + `.fn.js` pairing in that implementation) — simplified to
 * a stub: no `data_create`/`postSteps` job-polling machinery, since that's
 * implementation-specific business logic `add` has no way to guess. The
 * `<segment>.fn.test.yaml` shape (a `handler: ./<file>.fn.js` + `cases:`
 * list) is ported the same way from `workflow-studio`'s function tests — the
 * only implementation in the source repo that has any.
 *
 * `order:` is deliberately omitted from the scaffolded rule.yaml: the `bffless`
 * CLI's rule-manifest schema treats it as optional and derives an order from
 * path specificity when it's absent (`RuleManifestSchema` /
 * `sortRulesBySpecificity`, the `bffless` npm package's `format/manifest.js`
 * / `format/routes.ts`) — a stub scaffold has no basis for picking a number
 * that would only need revisiting once real rules accumulate around it.
 *
 * Every fallible step is guarded exactly like ../verbs/init.ts: a full
 * preflight (does the workflow file already exist? does any target rule
 * path already exist?) runs before anything is written, so a name collision
 * or a re-run over an existing stub exits 2 having touched nothing, rather
 * than silently clobbering hand-edited files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readIdentity } from '../identity.js'

type Print = (line: string) => void

export interface AddArgs {
  name: string
  steps: string[]
}

/** The workflow schema's `identifier` pattern (job id, step id): `^[a-z][a-z0-9_-]*$`. */
const IDENTIFIER_RE = /^[a-z][a-z0-9_-]*$/

/** The workflow schema's relative `with.path` pattern: lowercase, digits, `_-./`, no leading/trailing slash. */
const STEP_PATH_RE = /^[a-z0-9_.-]+(\/[a-z0-9_.-]+)*$/

/** `--step` is the only flag; everything else is the one positional `<name>`. */
export function parseAdd(rest: string[]): AddArgs | { error: string } {
  const positional: string[] = []
  const steps: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? ''
    if (a === '--step') {
      const value = rest[++i]
      if (value === undefined || value.startsWith('--')) return { error: '--step needs a value' }
      steps.push(value)
    } else if (a.startsWith('--')) {
      return { error: `unknown option ${a}` }
    } else {
      positional.push(a)
    }
  }

  if (positional.length === 0) return { error: 'usage: add <name> [--step <path>]…' }
  if (positional.length > 1) return { error: 'add takes exactly one argument: <name>' }

  return { name: positional[0] as string, steps }
}

interface StepPlan {
  /** The step's `id:` within the job — the path's last segment, de-duplicated if it collides. */
  stepId: string
  /** The pipeline step's `with.path` — the `--step` value, slashes trimmed. */
  path: string
  /** The path's last segment — also the rule dir's leaf name and the `.fn.js`/`.fn.test.yaml` stem. */
  segment: string
  /** `rules/<path>/post` relative to the rule-set directory. */
  ruleRelDir: string
}

/**
 * One plan per `--step` (or a single `<name>`-path step when none were
 * given, per the plan's default sketch). Validates every path/segment
 * against the schema's own patterns up front, so a bad `--step` value is
 * caught before anything is written rather than producing a workflow YAML
 * `lint` would immediately reject.
 */
function planSteps(steps: string[], name: string): StepPlan[] | { error: string } {
  const rawPaths = steps.length > 0 ? steps : [name]
  const plans: StepPlan[] = []
  const seenIds = new Set<string>()

  for (const raw of rawPaths) {
    const path = raw.replace(/^\/+/, '').replace(/\/+$/, '')
    if (path === '' || !STEP_PATH_RE.test(path)) {
      return { error: `--step "${raw}" is not a valid relative path: expected ${STEP_PATH_RE}` }
    }
    const segment = path.split('/').pop() as string
    if (!IDENTIFIER_RE.test(segment)) {
      return {
        error: `--step "${raw}"'s last segment "${segment}" is not a valid step id: expected ${IDENTIFIER_RE}`,
      }
    }

    let stepId = segment
    for (let n = 2; seenIds.has(stepId); n++) stepId = `${segment}${n}`
    seenIds.add(stepId)

    plans.push({ stepId, path, segment, ruleRelDir: `${path}/post` })
  }

  return plans
}

const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url))
const WORKFLOW_TMPL = readFileSync(join(TEMPLATES_DIR, 'workflow.yaml.tmpl'), 'utf8')
const RULE_TMPL = readFileSync(join(TEMPLATES_DIR, 'rule.yaml.tmpl'), 'utf8')
const FN_JS_TMPL = readFileSync(join(TEMPLATES_DIR, 'fn.js.tmpl'), 'utf8')
const FN_TEST_TMPL = readFileSync(join(TEMPLATES_DIR, 'fn.test.yaml.tmpl'), 'utf8')

function render(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/__([A-Z_]+)__/g, (_match, key: string) => {
    if (!(key in vars)) throw new Error(`template placeholder __${key}__ has no value`)
    return vars[key] as string
  })
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function renderWorkflow(name: string, plans: StepPlan[]): string {
  const stepsBlock = plans
    .map((p) => `      - id: ${p.stepId}\n        uses: pipeline\n        with:\n          path: ${p.path}`)
    .join('\n')
  const title = titleCase(name)
  return render(WORKFLOW_TMPL, {
    NAME: title,
    DESCRIPTION: `${title} — scaffolded by \`workflow add\`.`,
    JOB_ID: name,
    STEPS: stepsBlock,
  })
}

function renderRule(plan: StepPlan): string {
  return render(RULE_TMPL, {
    TITLE: titleCase(plan.segment),
    DESCRIPTION: `POST /${plan.path} — scaffolded by \`workflow add\`; replace with ${plan.segment}'s real behavior.`,
    SEGMENT: plan.segment,
  })
}

/** Every path `add` would write for one step: the rule manifest, the handler, and its test. */
function stepFiles(ruleSetDir: string, plan: StepPlan): { rule: string; fn: string; fnTest: string } {
  const dir = join(ruleSetDir, 'rules', ...plan.ruleRelDir.split('/'))
  return {
    rule: join(dir, 'rule.yaml'),
    fn: join(dir, `${plan.segment}.fn.js`),
    fnTest: join(dir, `${plan.segment}.fn.test.yaml`),
  }
}

/**
 * Runs `add` rooted at `cwd` — an already-`init`ed implementation directory,
 * read via `readIdentity` (same testability rationale as ../verbs/rename.ts
 * and ../verbs/init.ts: `dir` is a parameter, cli.ts passes `process.cwd()`
 * for the real invocation).
 */
export function runAdd(cwd: string, parsed: AddArgs, out: Print, err: Print): number {
  if (!IDENTIFIER_RE.test(parsed.name)) {
    err(`workflow: "${parsed.name}" is not a valid workflow name: expected ${IDENTIFIER_RE}`)
    return 2
  }

  let identity
  try {
    identity = readIdentity(cwd)
  } catch (e) {
    err(`workflow: ${(e as Error).message}`)
    return 2
  }

  const ruleSetDir = join(cwd, '.bffless', 'proxy-rules', identity.alias)
  if (!existsSync(join(ruleSetDir, 'ruleset.yaml'))) {
    err(`workflow: no rule set at ${relative(cwd, ruleSetDir)} — run \`workflow init\` first`)
    return 2
  }

  const plansResult = planSteps(parsed.steps, parsed.name)
  if ('error' in plansResult) {
    err(`workflow: ${plansResult.error}`)
    return 2
  }
  const plans = plansResult

  const workflowFile = join(cwd, '.bffless', 'workflows', `${parsed.name}.workflow.yaml`)

  // A full preflight before any write: an existing workflow name, or any
  // rule-stub path a re-run (or a name/step collision) would clobber, exits
  // 2 having touched nothing — same discipline as init.ts's destination
  // conflict guard.
  const conflicts = [workflowFile, ...plans.flatMap((p) => Object.values(stepFiles(ruleSetDir, p)))].filter((f) =>
    existsSync(f),
  )
  if (conflicts.length > 0) {
    err(`workflow: ${conflicts.length} path(s) already exist — refusing to overwrite:`)
    for (const c of conflicts) err(`  ${relative(cwd, c)}`)
    return 2
  }

  try {
    mkdirSync(dirname(workflowFile), { recursive: true })
    writeFileSync(workflowFile, renderWorkflow(parsed.name, plans))

    for (const p of plans) {
      const files = stepFiles(ruleSetDir, p)
      mkdirSync(dirname(files.rule), { recursive: true })
      writeFileSync(files.rule, renderRule(p))
      writeFileSync(files.fn, render(FN_JS_TMPL, { SEGMENT: p.segment }))
      writeFileSync(files.fnTest, render(FN_TEST_TMPL, { SEGMENT: p.segment }))
    }
  } catch (e) {
    err(`workflow: ${(e as Error).message}`)
    return 2
  }

  out(`add ${relative(cwd, workflowFile)}`)
  for (const p of plans) {
    const files = stepFiles(ruleSetDir, p)
    out(`add ${relative(cwd, files.rule)}`)
    out(`add ${relative(cwd, files.fn)}`)
    out(`add ${relative(cwd, files.fnTest)}`)
  }
  out(`✔ added workflow ${parsed.name} (${plans.length} step${plans.length === 1 ? '' : 's'})`)
  return 0
}
