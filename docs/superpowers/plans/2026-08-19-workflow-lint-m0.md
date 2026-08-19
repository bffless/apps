# Workflow Lint (M0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `workflow lint` prototype — YAML → schema validation (ajv draft-2020) → `${{ }}` expression parse/eval module → static checks — as a pure workspace package the M1 harness will reuse, with a CLI (`workflow lint <file...>`) producing human + JSON output.

**Architecture:** One new pnpm workspace package `packages/workflow-lint` (`@bffless/workflow-lint`, private). Pure TypeScript ESM, no React, no network, no `eval`. Layers: YAML loader with source positions → ajv schema validation → expression lexer/parser/evaluator (the module `lib/runner/expressions` reuses in M1) → a definition walker that indexes every expression with its position/slot → rule modules that consume that index. A thin CLI wraps the programmatic API; the future `bffless workflows lint` verb wraps the same API.

**Tech Stack:** TypeScript ~6.0.2 (repo standard), Node ≥ 20, pnpm 10, `yaml` ^2 (position-aware parse), `ajv` ^8 (`Ajv2020`), vitest ^4, eslint ^10 (flat config, mirroring studio minus React).

**Spec:** `apps/workflow/docs/spec/` — 00-overview.md (M0 scope), 01-workflow-yaml.md (grammar, contexts, upstream rule), 02-types-and-renderers.md (type vocabulary, renderers), 03-step-kinds.md (body/paths rules, omitted-outputs warning), 07-headless.md (skip/auto lint rules), 09-state-management.md (the linter's check list, module purity), `workflow.schema.json` (draft 2020-12), `examples/hello.workflow.yaml` + `examples/studio.workflow.yaml`.

## Placement decision (weighed, as requested)

**Option A — give `apps/workflow/` a `package.json` now.** The moment it exists, `scripts/check-app-conventions.mjs` stops skipping the dir and demands an authored rule set at `apps/workflow/.bffless/proxy-rules/*/ruleset.yaml` plus `apps/workflow/bffless/README.md` with "Manual setup (admin panel)" and "First-success checkpoint" sections. The harness's rule set is designed (spec 06) but *building* it is M1 — M0 would have to fabricate a stub rule set and a stub install README that describe nothing real, and `rules-drift-check.yml` / the getting-started contract would then treat those stubs as truth.

**Option B — separate workspace package `packages/workflow-lint`; `apps/workflow/` stays spec-only until M1.** `pnpm-workspace.yaml` already lists `packages/*` (currently empty). The conventions check never looks at `packages/`. Spec 07 already plans `packages/workflow-headless` for the Playwright driver, so a `packages/` area for workflow tooling is the spec's own shape. In M1 the harness app adds `"@bffless/workflow-lint": "workspace:*"` and imports the pure modules (`expressions`, `definition`) exactly as 09 requires ("one parser shared by the harness and the linter"). Not a release-please component; publishing to npm (for the `bffless` CLI to wrap) is a later, separate decision.

**Decision: Option B.** No fake convention artifacts, no CI fights, and the spec itself already points at `packages/` for workflow tooling.

## Global Constraints

- Node `>=20`, ESM only (`"type": "module"`), TypeScript `~6.0.2`, no CommonJS output.
- No `eval` / `new Function`; no React; no network access anywhere in the package (09).
- JSON Schema dialect: draft 2020-12; validate with `Ajv2020` (`ajv/dist/2020.js`), options `{ allErrors: true, allowUnionTypes: true, strict: false }`.
- Identifiers: `^[a-z][a-z0-9_-]*$` (01). Durations: `^[0-9]+(ms|s|m|h)$` (schema).
- Renderer names: exactly `transcript | chart | images | code | island` (02); unknown `render` is a **lint error, not a runtime fallback**.
- Interactive step kinds are `island` and `form` (03/07); `script` is not interactive.
- Severity policy: `error` and `warning` → exit code 1; `notice` → informational, exit 0. "Both spec examples lint clean" = exit 0 with **zero errors and zero warnings** (hello legitimately emits one notice: `boom` omits `outputs`, which 03 says the linter flags — implemented as a notice for exactly this reason).
- The expression module is shared with M1: parser AND evaluator ship now, fully unit-tested, even though lint itself only needs the parser + static analysis.
- Schema source of truth stays at `apps/workflow/docs/spec/workflow.schema.json`; the package carries a byte-identical copy at `packages/workflow-lint/schema/workflow.schema.json`, fenced by a test.
- Work happens in a worktree at `repos/apps/.claude/worktrees/workflow-lint-m0` on branch `feat/workflow-lint-m0`; never commit on the shared main checkout. Push every commit before opening the PR. Squash-merge repo: the PR title is the commit — `feat(workflow-lint): workflow lint prototype for M0`.
- Commit after every task (conventional messages, scope `workflow-lint`).

## File structure

```
packages/workflow-lint/
  package.json                  @bffless/workflow-lint, private, bin: workflow → dist/cli.js
  tsconfig.json                 nodenext, strict, outDir dist
  eslint.config.js              flat, typescript-eslint, no React plugins
  vitest.config.ts
  README.md                     usage + rule table (Task 16)
  schema/workflow.schema.json   byte-identical copy (drift-fenced)
  src/
    index.ts                    lintSource() / lintFile() / Finding — the public API
    findings.ts                 Finding type + severity ordering + counters
    yaml/load.ts                position-aware YAML load + ${{-in-flow hint
    schema/validate.ts          ajv wrapper + step-oneOf error refinement
    expressions/
      ast.ts                    Expr / Span types
      lexer.ts                  tokenizer
      parser.ts                 parseExpression()
      template.ts               scanTemplates() / renderTemplate() / single-expression rule
      functions.ts              contains/startsWith/…/length/pluck
      evaluate.ts               evaluate(expr, contexts) — M1-shared
    model/
      definition.ts             Definition/Job/Step typed model over validated data
      slots.ts                  collectSites(def) → ExprSite[] (every expression + its slot)
      contexts.ts               availability table (which roots are legal per slot)
      types.ts                  VType, buildTypeEnv(), inferType()
      graph.ts                  needs DAG checks (unknown job, cycle)
    checks/
      index.ts                  runChecks(def, sites, locate) → Finding[]
      ids.ts                    duplicate-step-id
      graph.ts                  needs-unknown, needs-cycle
      contexts.ts               unknown-context, context-position, status-fn-position, unknown-function
      upstream.ts               upstream-reference (steps/needs/jobs), unknown-output
      render.ts                 unknown-render, island-render-src
      paths.ts                  cross-impl-path
      body.ts                   file-ref-in-body
      headless.ts               interactive-headless, headless-skip-outputs
      outputs.ts                outputs-omitted, untyped-job-output
    cli.ts                      arg parsing, human + --json reporters, exit codes
  test/
    schema-drift.test.ts
    yaml-load.test.ts
    lexer.test.ts  parser.test.ts  template.test.ts  evaluate.test.ts
    schema-validate.test.ts
    slots.test.ts  types.test.ts
    checks/*.test.ts            one file per rule group, inline YAML strings
    examples.test.ts            both spec examples lint clean
    corpus.test.ts              fixtures/broken/* each yields its expected findings
    cli.test.ts
    fixtures/broken/*.workflow.yaml
```

## Rule inventory (traceability)

| rule id | severity | source |
|---|---|---|
| `yaml-parse` (+ flow-`${{` hint) | error | 01 "YAML gotcha" |
| `schema` (ajv, refined per step kind) | error | scope; workflow.schema.json |
| `expr-parse` | error | 01 grammar |
| `duplicate-step-id` | error | 01 "unique within their scope" (schema can't see arrays) |
| `needs-unknown`, `needs-cycle` | error | 01 jobs semantics |
| `unknown-context` / `context-position` | error | 01 contexts table |
| `status-fn-position` | error | 01 "valid in `if` only" |
| `unknown-function` | error | 01 closed function set |
| `upstream-reference` | error | 01 "Upstream rule (linted…)" |
| `unknown-output` | warning | corollary of upstream rule (typo fence; both examples pass) |
| `unknown-render`, `island-render-src` | error | 02 "Unknown render values are a lint error" |
| `cross-impl-path` | warning | 01 "linter warns on absolute paths into another implementation" |
| `file-ref-in-body` | warning | 03 "linter warns when a whole File ref … is placed in a body" |
| `interactive-headless` | notice | 07 "reports every interactive step lacking headless as a notice" |
| `headless-skip-outputs` | error | 07 "Lint error if a declared output that a later expression references has no skip value" |
| `outputs-omitted` | notice | 03 "discouraged in shipped workflows (the linter warns)" — notice so hello stays clean |
| `untyped-job-output` | notice | 01 "typed json unless you declare the object form (the linter suggests it)" |

---

### Task 1: Worktree + package scaffold + schema drift fence

**Files:**
- Create: worktree `repos/apps/.claude/worktrees/workflow-lint-m0` (branch `feat/workflow-lint-m0` from `origin/main`)
- Create: `packages/workflow-lint/package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`
- Create: `packages/workflow-lint/schema/workflow.schema.json` (copy of `apps/workflow/docs/spec/workflow.schema.json`)
- Create: `docs/superpowers/plans/2026-08-19-workflow-lint-m0.md` (this plan)
- Modify: root `package.json` (two scripts)
- Test: `packages/workflow-lint/test/schema-drift.test.ts`

**Interfaces:**
- Produces: a buildable, testable empty package other tasks add to; `pnpm --filter @bffless/workflow-lint test:run` green.

- [ ] **Step 1: Create the worktree** (never commit on the shared checkout)

```bash
cd /home/rico/bffless/repos/apps
git worktree add .claude/worktrees/workflow-lint-m0 -b feat/workflow-lint-m0 origin/main
cd .claude/worktrees/workflow-lint-m0
```

- [ ] **Step 2: Scaffold the package**

`packages/workflow-lint/package.json`:

```json
{
  "name": "@bffless/workflow-lint",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "description": "Parser, schema validation, expression engine and static checks for BFFless Workflow YAML (spec: apps/workflow/docs/spec/)",
  "bin": { "workflow": "dist/cli.js" },
  "exports": {
    ".": "./dist/index.js",
    "./expressions": "./dist/expressions/index.js",
    "./definition": "./dist/model/definition.js"
  },
  "files": ["dist", "schema"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -b",
    "lint": "eslint .",
    "test": "vitest",
    "test:run": "vitest run",
    "cli": "node dist/cli.js"
  },
  "dependencies": {
    "ajv": "^8.17.1",
    "yaml": "^2.8.0"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/node": "^24.12.3",
    "eslint": "^10.3.0",
    "globals": "^17.6.0",
    "typescript": "~6.0.2",
    "typescript-eslint": "^8.59.2",
    "vitest": "^4.1.7"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
```

`eslint.config.js` mirrors studio's flat config minus React plugins (`@eslint/js` recommended + `typescript-eslint` recommended over `src/**/*.ts`, `test/**/*.ts`; ignore `dist`).

Copy the schema: `cp apps/workflow/docs/spec/workflow.schema.json packages/workflow-lint/schema/workflow.schema.json`.

Root `package.json` scripts (alongside the `studio:*` family):

```json
"workflow-lint:build": "pnpm --filter @bffless/workflow-lint build",
"workflow-lint:test": "pnpm --filter @bffless/workflow-lint test:run",
```

- [ ] **Step 3: Write the schema drift test**

`test/schema-drift.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { test, expect } from 'vitest'

const here = new URL('.', import.meta.url)
test('packaged schema is byte-identical to the spec schema', () => {
  const packaged = readFileSync(new URL('../schema/workflow.schema.json', here), 'utf8')
  const spec = readFileSync(new URL('../../../apps/workflow/docs/spec/workflow.schema.json', here), 'utf8')
  expect(packaged).toBe(spec)
})
```

- [ ] **Step 4: Install and verify**

Run: `pnpm install` (updates `pnpm-lock.yaml` — commit it), then `pnpm --filter @bffless/workflow-lint test:run`
Expected: 1 test PASS.

- [ ] **Step 5: Copy this plan into `docs/superpowers/plans/2026-08-19-workflow-lint-m0.md` and commit**

```bash
git add packages/workflow-lint pnpm-lock.yaml package.json docs/superpowers/plans/2026-08-19-workflow-lint-m0.md
git commit -m "chore(workflow-lint): scaffold package + schema drift fence + M0 plan"
```

---

### Task 2: YAML loader with source positions

**Files:**
- Create: `src/yaml/load.ts`, `src/findings.ts`
- Test: `test/yaml-load.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // findings.ts
  export type Severity = 'error' | 'warning' | 'notice'
  export interface Finding {
    rule: string; severity: Severity; message: string
    path: string                     // JSON pointer, '' = whole doc
    pos?: { line: number; col: number }  // 1-based
    hint?: string
  }
  // yaml/load.ts
  export interface LoadedYaml {
    data: unknown                    // plain JS value (undefined when fatal)
    findings: Finding[]              // yaml-parse errors
    locate(pointer: string): { line: number; col: number } | undefined
  }
  export function loadYaml(source: string): LoadedYaml
  ```

- [ ] **Step 1: Write failing tests**

```ts
import { test, expect } from 'vitest'
import { loadYaml } from '../src/yaml/load.js'

test('parses valid YAML and locates a nested pointer', () => {
  const r = loadYaml('name: hi\njobs:\n  a:\n    steps:\n      - id: one\n')
  expect(r.findings).toEqual([])
  expect((r.data as any).jobs.a.steps[0].id).toBe('one')
  expect(r.locate('/jobs/a/steps/0/id')).toEqual({ line: 5, col: 9 })
})

test('reports a parse error with position', () => {
  const r = loadYaml('a: [1, 2\n')
  expect(r.findings[0]!.rule).toBe('yaml-parse')
  expect(r.findings[0]!.severity).toBe('error')
  expect(r.findings[0]!.pos?.line).toBe(1)
})

test('unquoted ${{ }} inside a flow mapping gets the quoting hint', () => {
  const r = loadYaml('body: { id: ${{ response.jobId }} }\n')
  expect(r.findings.length).toBeGreaterThan(0)
  expect(r.findings[0]!.hint).toMatch(/quote/i)
})

test('duplicate keys are an error', () => {
  const r = loadYaml('a: 1\na: 2\n')
  expect(r.findings[0]!.rule).toBe('yaml-parse')
})
```

- [ ] **Step 2: Run, verify FAIL** — `pnpm --filter @bffless/workflow-lint exec vitest run test/yaml-load.test.ts`

- [ ] **Step 3: Implement**

```ts
import { parseDocument, LineCounter, isNode } from 'yaml'
import type { Finding } from '../findings.js'

const FLOW_EXPR_HINT =
  'Inside a flow mapping/sequence ({ … } / [ … ]) an expression must be quoted — ' +
  'write body: { id: "${{ response.jobId }}" } — because ${{ opens a nested mapping. ' +
  'Block style needs no quotes.'

export function loadYaml(source: string): LoadedYaml {
  const lineCounter = new LineCounter()
  const doc = parseDocument(source, { lineCounter, uniqueKeys: true })
  const findings: Finding[] = doc.errors.map((err) => {
    const [offset] = err.pos
    const { line, col } = lineCounter.linePos(offset)
    // the ${{-in-flow gotcha: the offending line contains a flow opener followed by ${{
    const lineText = source.split('\n')[line - 1] ?? ''
    const hint = /[{[][^\n]*\$\{\{/.test(lineText) ? FLOW_EXPR_HINT : undefined
    return { rule: 'yaml-parse', severity: 'error', message: err.message, path: '', pos: { line, col }, hint }
  })
  const data = findings.length > 0 && doc.errors.some((e) => e.name === 'YAMLParseError')
    ? doc.toJS({ maxAliasCount: 100 })   // best effort; may be partial
    : doc.toJS({ maxAliasCount: 100 })
  return {
    data,
    findings,
    locate(pointer) {
      if (pointer === '') return { line: 1, col: 1 }
      const segs = pointer.slice(1).split('/').map((s) => {
        const un = s.replaceAll('~1', '/').replaceAll('~0', '~')
        return /^\d+$/.test(un) ? Number(un) : un
      })
      const node = doc.getIn(segs, true)
      if (!isNode(node) || node.range == null) return undefined
      return lineCounter.linePos(node.range[0])
    },
  }
}
```

(`yaml` v2 flags duplicate keys as errors under `uniqueKeys: true` — no extra rule needed.)

- [ ] **Step 4: Run, verify PASS** (adjust the expected line/col in test 1 to the real linePos values if off-by-one — verify against actual output, don't fudge the implementation)

- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): position-aware YAML loader with flow-expression hint"`

---

### Task 3: Expression lexer

**Files:**
- Create: `src/expressions/ast.ts`, `src/expressions/lexer.ts`
- Test: `test/lexer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // ast.ts
  export interface Span { start: number; end: number }
  export type Expr =
    | { kind: 'null' | 'true' | 'false'; span: Span }
    | { kind: 'number'; value: number; span: Span }
    | { kind: 'string'; value: string; span: Span }
    | { kind: 'ident'; name: string; span: Span }
    | { kind: 'member'; object: Expr; property: string; span: Span }
    | { kind: 'index'; object: Expr; index: Expr; span: Span }
    | { kind: 'call'; callee: string; args: Expr[]; span: Span }
    | { kind: 'not'; operand: Expr; span: Span }
    | { kind: 'binary'; op: BinOp; left: Expr; right: Expr; span: Span }
  export type BinOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||'
  export class ExprSyntaxError extends Error { constructor(message: string, public offset: number) { super(message) } }
  // lexer.ts
  export type Token =
    | { kind: 'ident' | 'punct'; text: string; span: Span }
    | { kind: 'number'; value: number; span: Span }
    | { kind: 'string'; value: string; span: Span }
    | { kind: 'eof'; span: Span }
  export function tokenize(src: string): Token[]   // throws ExprSyntaxError
  ```

- [ ] **Step 1: Write failing tests** — identifiers may contain `-` and `_` (`strategy.job-index`, `needs.per-video`); single-quoted strings with `''` escape; numbers incl. floats, exponents, hex, and negative literals; every operator; unterminated string throws.

```ts
import { test, expect } from 'vitest'
import { tokenize } from '../src/expressions/lexer.js'
import { ExprSyntaxError } from '../src/expressions/ast.js'

const kinds = (s: string) => tokenize(s).map((t) => ('text' in t ? t.text : t.kind === 'eof' ? '<eof>' : (t as any).value))

test('identifiers keep dashes', () => {
  expect(kinds("needs.per-video.outputs")).toEqual(['needs', '.', 'per-video', '.', 'outputs', '<eof>'])
})
test('strings use double-single-quote escape', () => {
  expect(tokenize("'it''s'")[0]).toMatchObject({ kind: 'string', value: "it's" })
})
test('numbers', () => {
  expect(kinds('-3.5e2')).toEqual([-350, '<eof>'])
  expect(kinds('0xff')).toEqual([255, '<eof>'])
})
test('operators', () => {
  expect(kinds("a == 'b' && !c || d <= 1")).toEqual(['a', '==', 'b', '&&', '!', 'c', '||', 'd', '<=', 1, '<eof>'])
})
test('unterminated string throws with offset', () => {
  expect(() => tokenize("'abc")).toThrow(ExprSyntaxError)
})
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement** — a single scan loop:

```ts
const PUNCT = ['==', '!=', '<=', '>=', '&&', '||', '(', ')', '[', ']', '.', ',', '!', '<', '>']
const IDENT_START = /[A-Za-z_]/, IDENT = /[A-Za-z0-9_-]/

export function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) { i++; continue }
    if (c === "'") {                                  // single-quoted, '' escapes '
      let j = i + 1, val = ''
      for (;;) {
        if (j >= src.length) throw new ExprSyntaxError('unterminated string', i)
        if (src[j] === "'") {
          if (src[j + 1] === "'") { val += "'"; j += 2 } else { j++; break }
        } else { val += src[j]!; j++ }
      }
      out.push({ kind: 'string', value: val, span: { start: i, end: j } }); i = j; continue
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^-?(0x[0-9a-fA-F]+|[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?)/.exec(src.slice(i))!
      out.push({ kind: 'number', value: Number(m[0]), span: { start: i, end: i + m[0].length } })
      i += m[0].length; continue
    }
    if (IDENT_START.test(c)) {
      let j = i + 1
      while (j < src.length && IDENT.test(src[j]!)) j++
      out.push({ kind: 'ident', text: src.slice(i, j), span: { start: i, end: j } }); i = j; continue
    }
    const p = PUNCT.find((p) => src.startsWith(p, i))
    if (p) { out.push({ kind: 'punct', text: p, span: { start: i, end: i + p.length } }); i += p.length; continue }
    throw new ExprSyntaxError(`unexpected character '${c}'`, i)
  }
  out.push({ kind: 'eof', span: { start: i, end: i } })
  return out
}
```

- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): expression lexer"`

---

### Task 4: Expression parser

**Files:**
- Create: `src/expressions/parser.ts`
- Test: `test/parser.test.ts`

**Interfaces:**
- Produces: `parseExpression(src: string): Expr` (throws `ExprSyntaxError`). Precedence (loosest → tightest): `||` < `&&` < `== !=` < `< <= > >=` < unary `!` < postfix `. [] ()`. Calls only on bare identifiers (`length(x)`, not `a.b(x)`), per the GitHub grammar.

- [ ] **Step 1: Write failing tests**

```ts
import { test, expect } from 'vitest'
import { parseExpression } from '../src/expressions/parser.js'

test('member + dynamic index', () => {
  const e = parseExpression("steps[matrix.video].outputs['wav']")
  expect(e.kind).toBe('member')                       // .outputs['wav'] → index at top
})
test('precedence: a || b && !c == d', () => {
  const e = parseExpression("a || b && !c == 'd'") as any
  expect(e.op).toBe('||')
  expect(e.right.op).toBe('&&')
  expect(e.right.right.op).toBe('==')
  expect(e.right.right.left.kind).toBe('not')
})
test('call with args', () => {
  const e = parseExpression("pluck(needs.per-video.outputs.sheets, 'path')") as any
  expect(e).toMatchObject({ kind: 'call', callee: 'pluck' })
  expect(e.args).toHaveLength(2)
})
test('literals', () => {
  expect(parseExpression('null').kind).toBe('null')
  expect(parseExpression('true').kind).toBe('true')
})
test('errors: trailing garbage, empty, bad token', () => {
  expect(() => parseExpression('a ||')).toThrow()
  expect(() => parseExpression('')).toThrow()
  expect(() => parseExpression('a b')).toThrow()      // two exprs
})
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement** — recursive descent over the token array:

```ts
export function parseExpression(src: string): Expr {
  const toks = tokenize(src)
  let pos = 0
  const peek = () => toks[pos]!
  const next = () => toks[pos++]!
  const expect_ = (text: string) => {
    const t = next()
    if (t.kind === 'eof' || !('text' in t) || t.text !== text)
      throw new ExprSyntaxError(`expected '${text}'`, t.span.start)
    return t
  }
  const isPunct = (text: string) => { const t = peek(); return t.kind === 'punct' && t.text === text }

  function parseOr(): Expr {
    let l = parseAnd()
    while (isPunct('||')) { next(); const r = parseAnd(); l = { kind: 'binary', op: '||', left: l, right: r, span: { start: l.span.start, end: r.span.end } } }
    return l
  }
  function parseAnd(): Expr { /* same shape over parseEquality, op '&&' */ }
  function parseEquality(): Expr { /* over parseRelational, ops '==' '!=' */ }
  function parseRelational(): Expr { /* over parseUnary, ops '<' '<=' '>' '>=' */ }
  function parseUnary(): Expr {
    if (isPunct('!')) { const t = next(); const operand = parseUnary(); return { kind: 'not', operand, span: { start: t.span.start, end: operand.span.end } } }
    return parsePostfix()
  }
  function parsePostfix(): Expr {
    let e = parsePrimary()
    for (;;) {
      if (isPunct('.')) {
        next(); const t = next()
        if (t.kind !== 'ident') throw new ExprSyntaxError('expected property name', t.span.start)
        e = { kind: 'member', object: e, property: t.text, span: { start: e.span.start, end: t.span.end } }
      } else if (isPunct('[')) {
        next(); const idx = parseOr(); const close = expect_(']')
        e = { kind: 'index', object: e, index: idx, span: { start: e.span.start, end: close.span.end } }
      } else break
    }
    return e
  }
  function parsePrimary(): Expr {
    const t = next()
    if (t.kind === 'number') return { kind: 'number', value: t.value, span: t.span }
    if (t.kind === 'string') return { kind: 'string', value: t.value, span: t.span }
    if (t.kind === 'punct' && t.text === '(') { const e = parseOr(); expect_(')'); return e }
    if (t.kind === 'ident') {
      if (t.text === 'null' || t.text === 'true' || t.text === 'false') return { kind: t.text, span: t.span }
      if (isPunct('(')) {                              // call
        next(); const args: Expr[] = []
        if (!isPunct(')')) { args.push(parseOr()); while (isPunct(',')) { next(); args.push(parseOr()) } }
        const close = expect_(')')
        return { kind: 'call', callee: t.text, args, span: { start: t.span.start, end: close.span.end } }
      }
      return { kind: 'ident', name: t.text, span: t.span }
    }
    throw new ExprSyntaxError('unexpected end of expression', t.span.start)
  }

  const e = parseOr()
  if (peek().kind !== 'eof') throw new ExprSyntaxError('unexpected token after expression', peek().span.start)
  return e
}
```

(The elided `parseAnd`/`parseEquality`/`parseRelational` are the same two-line loop as `parseOr` with their ops — write them out.)

- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): expression parser"`

---

### Task 5: Template scanner (interpolation + single-expression rule)

**Files:**
- Create: `src/expressions/template.ts`
- Test: `test/template.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TemplateSpan { src: string; start: number; end: number; expr?: Expr; error?: ExprSyntaxError }
  export function scanTemplates(value: string): TemplateSpan[]   // every ${{ … }} occurrence; never throws
  export function isSingleExpression(value: string): boolean      // exactly one ${{ }} spanning the whole (trimmed) scalar
  export function parseIfExpression(value: string): { expr?: Expr; error?: ExprSyntaxError; spans: TemplateSpan[] }
  // `if:` GitHub rule: a string with no ${{ at all is parsed whole as one expression;
  // otherwise it's a normal template.
  ```

- [ ] **Step 1: Write failing tests**

```ts
test('finds all spans with offsets', () => {
  const spans = scanTemplates('a ${{ x }} b ${{ y.z }}')
  expect(spans).toHaveLength(2)
  expect(spans[0]!.src).toBe(' x ')
  expect(spans[1]!.start).toBe(13)
})
test('parse error captured, not thrown', () => {
  expect(scanTemplates('${{ a || }}')[0]!.error).toBeDefined()
})
test('unclosed ${{ is an error span', () => {
  expect(scanTemplates('${{ a')[0]!.error).toBeDefined()
})
test('single expression detection', () => {
  expect(isSingleExpression('${{ inputs.names }}')).toBe(true)
  expect(isSingleExpression('hi ${{ x }}')).toBe(false)
})
test('bare if expression', () => {
  expect(parseIfExpression("steps.boom.outcome == 'failure'").expr).toBeDefined()
})
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement** — regex-free scan for `${{` then a manual search for the matching `}}` (expressions can't contain `}}` because `}` isn't in the token set — a simple `indexOf('}}')` is correct); each span body goes through `parseExpression` with errors captured.
- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): template scanner and if-expression handling"`

---

### Task 6: Evaluator + functions (the M1-shared half)

**Files:**
- Create: `src/expressions/evaluate.ts`, `src/expressions/functions.ts`, `src/expressions/index.ts` (re-exports the whole expressions surface)
- Test: `test/evaluate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EvalOptions {
    contexts: Record<string, unknown>              // inputs, needs, steps, matrix, response, error, step, run, impl, jobs, strategy
    status?: { success(): boolean; failure(): boolean; always(): boolean; cancelled(): boolean }
  }
  export function evaluate(expr: Expr, opts: EvalOptions): unknown
  export function renderTemplate(value: string, opts: EvalOptions): unknown
  // exactly-one-expression keeps its type; otherwise string interpolation
  export function interpolate(v: unknown): string
  // null→'' , boolean/number→String, string→itself, array/object→JSON.stringify
  // (documented deviation from GitHub's 'Array'/'Object' placeholders — strictly more useful)
  ```
- Semantics (GitHub, per 01): missing property → `null`, `null.x` → `null`, out-of-range/dynamic index miss → `null` — **never throws** on access. Truthiness: `false, 0, NaN, '', null` falsy. `==`/`!=`: both strings → case-insensitive compare; both same primitive type → strict; non-primitives → reference equality; mixed → coerce both to number (`null→0`, `bool→0/1`, `''→0`, string→`Number()`, object/array→NaN). `< <= > >=`: numeric coercion, `NaN` compares false. `&&`/`||` return operand values (not booleans), short-circuit.
- Functions (case-insensitive lookup): `contains(hay, needle)` (string: case-insensitive substring; array: loose-eq element), `startsWith`/`endsWith` (case-insensitive), `format('{0}…', …)` with `{{`/`}}` escapes, `join(arr, sep=',')`, `toJSON` (pretty, 2-space), `fromJSON`, `length(x)` (string chars / array items, anything else → 0), `pluck(list, key)` — maps a list of objects to their `key`; **descends nested lists** (matrix-collected list-of-lists → list-of-lists of the key, per the studio example's comment), non-object element → `null`. Status functions dispatch to `opts.status` and throw `EvalError('success() is only valid in if')` when `status` is absent. Unknown function → throws `EvalError`.

- [ ] **Step 1: Write failing tests** (the table below, one `test()` each)

```ts
const ctx = (contexts: any) => ({ contexts })
// null propagation
evaluate(parseExpression('a.b.c'), ctx({ a: {} }))                    // → null
evaluate(parseExpression('a[5]'), ctx({ a: [1] }))                    // → null
// dynamic index
evaluate(parseExpression('a[b]'), ctx({ a: { k: 7 }, b: 'k' }))       // → 7
// loose equality
evaluate(parseExpression("'ABC' == 'abc'"), ctx({}))                  // → true
evaluate(parseExpression("null == 0"), ctx({}))                       // → true (numeric coercion)
evaluate(parseExpression("'' == 0"), ctx({}))                         // → true
// logical operators return operands
evaluate(parseExpression("x || 'fallback'"), ctx({ x: null }))        // → 'fallback'
// functions
evaluate(parseExpression("length(a)"), ctx({ a: [1, 2, 3] }))         // → 3
evaluate(parseExpression("length(null)"), ctx({}))                    // → 0
evaluate(parseExpression("pluck(a, 'p')"), ctx({ a: [{ p: 1 }, { p: 2 }] }))          // → [1,2]
evaluate(parseExpression("pluck(a, 'p')"), ctx({ a: [[{ p: 1 }], [{ p: 2 }]] }))      // → [[1],[2]]
evaluate(parseExpression("format('{0} and {1}', 'a', 'b')"), ctx({})) // → 'a and b'
evaluate(parseExpression("contains(a, 2)"), ctx({ a: [1, 2] }))       // → true
evaluate(parseExpression("fromJSON('[1,2]')[1]"), ctx({}))            // → 2
// templates
renderTemplate('${{ inputs.names }}', ctx({ inputs: { names: ['a'] } }))   // → ['a'] (keeps type)
renderTemplate('hi ${{ x }}!', ctx({ x: 5 }))                              // → 'hi 5!'
// status functions
expect(() => evaluate(parseExpression('success()'), ctx({}))).toThrow()
evaluate(parseExpression('success()'), { contexts: {}, status: { success: () => true, failure: () => false, always: () => true, cancelled: () => false } }) // → true
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement** — a `switch` over `Expr['kind']`; member/index share one `access(obj, key)` helper returning `null` for any miss; coercion helpers `toNum`, `looseEq`, `truthy` in `evaluate.ts`; function table in `functions.ts` keyed lowercase.
- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): expression evaluator with GitHub semantics + length/pluck"`

---

### Task 7: Schema validation (ajv + step-branch error refinement)

**Files:**
- Create: `src/schema/validate.ts`
- Test: `test/schema-validate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function validateDefinition(data: unknown): Finding[]   // rule 'schema', severity 'error'
  ```
- ajv setup: `new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false })`, schema read with `readFileSync(new URL('../../schema/workflow.schema.json', import.meta.url))` (resolves from both `src/` under vitest and `dist/` at runtime — same depth), compiled once at module load.
- **Refinement:** a step failing the 4-way `oneOf` produces an ajv error storm. Post-process: group errors by step instancePath (`/jobs/<id>/steps/<n>`); if the step object has a `uses` that is one of `pipeline|island|form|script`, re-validate that step against the matching `$defs/<kind>Step` subschema alone and emit only those errors; if `uses` is missing/unknown, emit a single `uses must be one of: pipeline, island, form, script`.

- [ ] **Step 1: Write failing tests**

```ts
test('minimal valid workflow passes', () => {
  expect(validateDefinition({ name: 'x', on: { manual: {} }, jobs: { a: { steps: [{ id: 's', uses: 'pipeline', with: { path: 'echo' } }] } } })).toEqual([])
})
test('missing name is one schema error with the right pointer', () => {
  const f = validateDefinition({ on: { manual: {} }, jobs: { a: { steps: [{ id: 's', uses: 'pipeline', with: { path: 'echo' } }] } } })
  expect(f).toHaveLength(1)
  expect(f[0]!.path).toBe('')
  expect(f[0]!.message).toMatch(/name/)
})
test('bad step reports against its own kind, not the oneOf storm', () => {
  const f = validateDefinition({ name: 'x', on: { manual: {} }, jobs: { a: { steps: [{ id: 's', uses: 'pipeline' }] } } })
  expect(f.some((x) => x.message.match(/with/))).toBe(true)
  expect(f.length).toBeLessThan(4)                       // not one error per branch
})
test('unknown uses is a single clear error', () => {
  const f = validateDefinition({ name: 'x', on: { manual: {} }, jobs: { a: { steps: [{ id: 's', uses: 'shell' }] } } })
  expect(f).toHaveLength(1)
  expect(f[0]!.message).toMatch(/pipeline, island, form, script/)
})
test('bad identifier and bad duration are caught', () => {
  const f = validateDefinition({ name: 'x', on: { manual: { inputs: { BadName: { type: 'string' } } } }, jobs: { a: { steps: [{ id: 's', uses: 'pipeline', with: { path: 'e' }, retry: { max: 1, delay: '5 sec' } }] } } })
  expect(f.length).toBeGreaterThanOrEqual(2)
})
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement** as specified; compile per-kind validators from `schema.$defs.pipelineStep` etc. once (`ajv.compile({ ...sub, $defs: schema.$defs })` so intra-schema `$ref`s resolve).
- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): ajv schema validation with per-step-kind error refinement"`

---

### Task 8: Definition model + expression site collection

**Files:**
- Create: `src/model/definition.ts`, `src/model/contexts.ts`, `src/model/slots.ts`
- Test: `test/slots.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // definition.ts — a typed view over schema-valid data (no re-validation)
  export interface Definition { name: string; inputs: Record<string, InputDef>; jobs: Record<string, Job>; outputs: Record<string, OutputDecl> }
  export interface Job { id: string; needs: string[]; if?: string; matrix?: Record<string, unknown>; steps: Step[]; outputs: Record<string, OutputDecl>; raw: any }
  export interface Step { id: string; index: number; uses: 'pipeline' | 'island' | 'form' | 'script'; raw: any }
  export type OutputDecl = string | { type?: string; list?: boolean; value?: unknown; render?: string; src?: string; [k: string]: unknown }
  export function toDefinition(data: any): Definition

  // slots.ts — every expression in the document, with position + availability
  export interface ExprSite {
    expr?: Expr; parseError?: ExprSyntaxError
    raw: string                       // the expression source
    pointer: string                   // JSON pointer to the containing scalar
    slot: Slot
    isWholeValue: boolean             // scalar is exactly this one expression
  }
  export interface Slot {
    where: 'job-if' | 'job-output' | 'matrix' | 'step-if' | 'with' | 'body' | 'query' | 'poll' | 'retry-if'
         | 'step-output-value' | 'summary' | 'annotation-if' | 'annotation-message' | 'headless-output' | 'top-output'
    jobId?: string; stepIndex?: number; stepId?: string; stepUses?: Step['uses']
    isIf: boolean                     // status functions legal here
  }
  export function collectSites(def: Definition): ExprSite[]

  // contexts.ts
  export function allowedRoots(slot: Slot, job?: Job): Set<string>
  ```
- Availability table (from 01's contexts table): `inputs`, `run`, `impl` everywhere. `needs` in job-if, all step slots, job-output. `steps` in step slots, job-output. `matrix` + `strategy` in any slot of a matrix job (incl. its job-output and matrix values of *other* vars? no — matrix values are evaluated pre-fan-out: allow `inputs`, `needs`, `run`, `impl` only). `response` only in slots `poll`, `retry-if`, `step-output-value`, `summary`, `annotation-*` **of a pipeline step**. `error` in `retry-if` and `annotation-*` always, plus any step slot with `stepIndex > 0`. `step` in any step slot. `jobs` only in `top-output` (where `needs`/`steps` are NOT allowed).
- Walker detail: `if`-slots use `parseIfExpression` (bare expression allowed); all other string scalars use `scanTemplates`. Walk recursively through `with` (body/query values nested arbitrarily), `poll` (query/body/until/fail), `retry.if`, `outputs.*.value`, `summary`, `annotations[].if/message`, `headless.outputs.*`, `strategy.matrix.*`, job/top `outputs`. `form` steps: `with.fields.*.default` and `options` are step-slot expressions.

- [ ] **Step 1: Write failing tests** — feed a small definition (inline YAML → loadYaml → toDefinition) exercising: a matrix job, a pipeline step with poll/retry/outputs/summary/annotations, a form step, job + top outputs. Assert: total site count; a specific site's `pointer`, `slot.where`, `isWholeValue`; `allowedRoots` returns/omits `response`, `matrix`, `jobs` correctly for three representative slots.

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, verify PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): definition model, expression site collection, context availability"`

---

### Task 9: Graph + id checks

**Files:**
- Create: `src/model/graph.ts`, `src/checks/ids.ts`, `src/checks/graph.ts`
- Test: `test/checks/graph.test.ts`

**Interfaces:**
- Produces: `checkIds(def): Finding[]` (`duplicate-step-id`, error, pointer at the second occurrence), `checkGraph(def): Finding[]` (`needs-unknown` error per bad ref; `needs-cycle` error naming the cycle `a → b → a`).

- [ ] **Step 1: Write failing tests** — three inline YAML docs: duplicate step id in one job (error) vs same id in two jobs (fine); `needs: ghost` (error); `a needs b, b needs a` (one cycle error listing both).
- [ ] **Step 2–4: Red → implement (DFS cycle detection with a visiting set) → green**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): duplicate-step-id and needs graph checks"`

---

### Task 10: Context + upstream reference checks

**Files:**
- Create: `src/checks/contexts.ts`, `src/checks/upstream.ts`
- Test: `test/checks/contexts.test.ts`, `test/checks/upstream.test.ts`

**Interfaces:**
- Consumes: `collectSites`, `allowedRoots`, `parseExpression` ASTs.
- Produces: `checkContexts(def, sites): Finding[]` and `checkUpstream(def, sites): Finding[]`.
- `checkContexts` walks each site's AST for root references (an `ident` that is not a call): root ∉ allowedRoots(slot) → `unknown-context` error (message distinguishes "no such context" from "not available here": `response` outside a pipeline step says *where* it is available). Calls: callee not in the known set → `unknown-function` error; status function in a non-`if` slot → `status-fn-position` error.
- `checkUpstream`: for each `steps.<id>` chain in a site of job J at stepIndex i: unknown id → error; referenced index > i → error ("later step"); == i and slot.where ∉ {summary, annotation-if, annotation-message} → error (self-reference legal only in own summary/annotations). For each `needs.<job>` chain: job ∉ J.needs → error (message differs for "not a job" vs "not in needs"). For each `jobs.<id>` in top-output: unknown job → error. Additionally `unknown-output` (warning): `steps.<id>.outputs.<n>` / `needs.<job>.outputs.<n>` / `jobs.<id>.outputs.<n>` where the target declares outputs and `<n>` isn't among them — for form steps the declared outputs are `with.fields` keys; for a pipeline step with omitted outputs the single output is `response`.
- Root-reference extraction helper `rootChain(expr): { root: string; path: (string | null)[] } | undefined` (null = dynamic segment) lives in `upstream.ts` and is exported — Task 11's type inference reuses it.

- [ ] **Step 1: Write failing tests** — inline YAML fixtures asserting each finding fires (and the exact `rule`), plus green cases: self-reference in own `summary` (allowed), `steps.boom.outcome` after the step (allowed), `error` in a second step's body (allowed), `response` in `poll.until` (allowed) but `response` in a form step's summary (error), `success()` in `if` (allowed) vs in `summary` (error), `jobs.x` inside a step (error).
- [ ] **Step 2–4: Red → implement → green**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): context availability, upstream-reference and function checks"`

---

### Task 11: Type inference + render/path/body checks

**Files:**
- Create: `src/model/types.ts`, `src/checks/render.ts`, `src/checks/paths.ts`, `src/checks/body.ts`
- Test: `test/types.test.ts`, `test/checks/render-paths-body.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface VType { base: 'string'|'number'|'boolean'|'choice'|'file'|'table'|'markdown'|'json'|'unknown'; list: number }
  export function buildTypeEnv(def: Definition): TypeEnv
  // resolves: inputs.<n> (list:true → list 1); steps.<id>.outputs.<n> (typed map / form fields / island contract);
  // needs.<job>.outputs.<n> = declared job-output type, +1 list depth when the job has a matrix;
  // matrix.<var> = element type of its source expression (inputs.recordings: file list → file)
  export function inferType(expr: Expr, env: TypeEnv, site: Slot): VType
  // member/index chains via rootChain(); index into list → depth-1; '.path' on file → string;
  // pluck(x, k) keeps depth, base string when k='path' on file elems else unknown; length() → number;
  // anything unresolvable → { base: 'unknown', list: 0 }
  ```
  - `checkRender(def): Finding[]` — `unknown-render` (error) for `render` ∉ {transcript, chart, images, code, island} anywhere a typeDef appears (inputs, form fields, step outputs, job outputs); `island-render-src` (error) for `render: island` with no `src`.
  - `checkPaths(def): Finding[]` — `cross-impl-path` (warning) for `with.path`/`poll.path` starting `/api/` but not `/api/workflow/`: "absolute path into another implementation — prefer a relative path so previews (<alias>-pr-N) keep working; /api/workflow/… (the harness) is fine".
  - `checkBody(def, sites, env): Finding[]` — `file-ref-in-body` (warning): for sites with `slot.where` ∈ {body} (i.e. `with.body` and `poll.body` of pipeline steps only — script/island `with` legitimately take File refs per 03) and `isWholeValue`, when `inferType` is `file` at any list depth → warn with hint "pass `ref.path` for one file or `pluck(list, 'path')` for a list — bodies carry paths, never refs (03)".

- [ ] **Step 1: Write failing tests** — type env over a hello-like doc: `inputs.recordings` → file list 1; `matrix.video` → file; `matrix.video.path` → string; `needs.per-video.outputs.words` (matrix job) → json list 1; `pluck(needs.per-video.outputs.sheets, 'path')` → string list 2. Checks: `render: transcirpt` → error; `render: island` w/o src → error; `with.path: /api/studio/x` → warning, `/api/workflow/files` → clean, `path: transcribe` → clean; `body: { video: "${{ matrix.video }}" }` → warning; `body: { video: "${{ matrix.video.path }}" }` and script-step `with: { video: "${{ matrix.video }}" }` → clean.
- [ ] **Step 2–4: Red → implement → green**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): type inference; render, cross-impl path and file-ref-in-body checks"`

---

### Task 12: Headless + outputs checks

**Files:**
- Create: `src/checks/headless.ts`, `src/checks/outputs.ts`
- Test: `test/checks/headless.test.ts`, `test/checks/outputs.test.ts`

**Interfaces:**
- Produces:
  - `checkHeadless(def, sites): Finding[]` —
    `interactive-headless` (notice): island/form step with no `headless` key — "not headless-safe: a headless run fails fast at this step (07); declare headless: skip|auto".
    `headless-skip-outputs` (error): for each interactive step S with mode `skip` (bare `'skip'` or `{mode:'skip'}`), collect every output name referenced by later expressions — sites in the same job with `stepIndex > S.index` (any slot) plus the job's `outputs` values — as `steps.<S.id>.outputs.<n>`; each such `<n>` must be a key of `headless.outputs` (bare `'skip'` has none). Message names the missing output and the referencing site.
  - `checkOutputs(def, sites): Finding[]` —
    `outputs-omitted` (notice): pipeline step with no `outputs` map — "step exposes only outputs.response (json); discouraged in shipped workflows (03)".
    `untyped-job-output` (notice): a job output declared as a bare expression string that is not a direct reference (single member chain rooted at `steps.<id>.outputs.<n>`, `inputs.<n>`, or `matrix.<v>` — no calls/operators/indexing) — "type will be json; declare { type: …, value: … } to keep the real type (01)".

- [ ] **Step 1: Write failing tests** — skip-step with a referenced output missing from `headless.outputs` (error), same with the value present (clean), bare `headless: skip` with any referenced output (error), referenced only by earlier steps (clean); form step w/o headless (notice), island with `headless: auto` (clean); pipeline w/o outputs (notice); job output `${{ length(steps.a.outputs.x) }}` (notice) vs `${{ steps.a.outputs.x }}` (clean) vs object form (clean).
- [ ] **Step 2–4: Red → implement → green**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): headless and outputs checks"`

---

### Task 13: Public API assembly + spec examples must lint clean

**Files:**
- Create: `src/index.ts`, `src/checks/index.ts`
- Test: `test/examples.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LintResult { file?: string; findings: Finding[]; counts: { errors: number; warnings: number; notices: number } }
  export function lintSource(source: string, opts?: { file?: string }): LintResult
  export function lintFile(path: string): LintResult      // readFileSync + lintSource
  ```
- Pipeline inside `lintSource`: `loadYaml` → if fatal parse errors, return them alone → `validateDefinition` → if schema errors, return yaml+schema findings (static checks need a valid shape) → `toDefinition` + `collectSites` → `expr-parse` findings from sites with `parseError` (pointer + hint when the source line matches the flow-`${{` pattern) → `runChecks` (ids, graph, contexts, upstream, render, paths, body, headless, outputs) → attach `pos` to every finding via `locate(pointer)` → sort by line, then severity.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs'
import { test, expect } from 'vitest'
import { lintSource } from '../src/index.js'

const example = (n: string) =>
  readFileSync(new URL(`../../../apps/workflow/docs/spec/examples/${n}`, import.meta.url), 'utf8')

test('hello.workflow.yaml lints clean (one known notice)', () => {
  const r = lintSource(example('hello.workflow.yaml'), { file: 'hello.workflow.yaml' })
  expect(r.findings.filter((f) => f.severity !== 'notice')).toEqual([])
  expect(r.findings.map((f) => f.rule)).toEqual(['outputs-omitted'])   // flaky/boom, by design
})

test('studio.workflow.yaml lints fully clean', () => {
  const r = lintSource(example('studio.workflow.yaml'), { file: 'studio.workflow.yaml' })
  expect(r.findings).toEqual([])
})
```

- [ ] **Step 2: Run, verify FAIL (or fail on real gaps)** — this is the integration crunch: any false positive against the two spec examples is a bug in a check (or, if a check is provably right and the example provably wrong, STOP and flag it to the user — the examples are merged spec; do not silently "fix" either side).
- [ ] **Step 3: Implement `src/index.ts` + fix whatever the examples flush out**
- [ ] **Step 4: Run the full suite, verify PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): lintSource public API; spec examples lint clean"`

---

### Task 14: Broken-workflow corpus

**Files:**
- Create: `test/fixtures/broken/*.workflow.yaml` (12 files) + `test/corpus.test.ts`

Corpus (filename → seeded defect → expected rule):

| fixture | defect | expects |
|---|---|---|
| `schema-bad-shape` | no `name`, job without `steps`, `timeout-minutes: 0` | `schema` ×3 |
| `flow-expr-unquoted` | `body: { id: ${{ response.jobId }} }` | `yaml-parse` with the quoting hint |
| `expr-syntax` | `if: ${{ inputs.a && }}` and unclosed `${{` in a summary | `expr-parse` ×2 |
| `forward-reference` | step 1 reads `steps.later.outputs.x`; step self-ref in `with` | `upstream-reference` ×2 |
| `needs-violations` | reads `needs.other` w/o listing it; `needs: ghost`; `a↔b` cycle | `upstream-reference`, `needs-unknown`, `needs-cycle` |
| `context-misuse` | `response` in a form summary; `matrix.x` in a non-matrix job; `jobs.a` in a step; `succes()` typo; `always()` in a summary | `unknown-context`/`context-position` ×3, `unknown-function`, `status-fn-position` |
| `unknown-render` | `render: fancy`; `render: island` without `src` | `unknown-render`, `island-render-src` |
| `no-headless` | island step with no `headless` | `interactive-headless` (notice) |
| `file-ref-body` | `body: { video: "${{ inputs.recording }}" }` (file input); matrix-collected `file` list passed whole | `file-ref-in-body` ×2 |
| `cross-impl-path` | `with: { path: /api/studio/transcribe }`; poll path `/api/other/job`; `/api/workflow/files/x` must NOT flag | `cross-impl-path` ×2 |
| `skip-missing-output` | form `headless: skip` (bare) with its field read by job outputs; second step `{mode: skip, outputs: {}}` with a referenced output | `headless-skip-outputs` ×2 |
| `dup-and-untyped` | duplicate step id; pipeline w/o outputs; job output `${{ length(steps.a.outputs.x) }}` | `duplicate-step-id`, `outputs-omitted`, `untyped-job-output` |

`test/corpus.test.ts` drives a table of `{ fixture, expected: Array<{ rule, severity, pathIncludes? }> }` and asserts the found rule multiset matches exactly (no extra findings — false-positive fence).

- [ ] **Step 1: Write the fixtures + table test; run — failures here are real check bugs**
- [ ] **Step 2: Fix checks until green; full suite green**
- [ ] **Step 3: Commit** — `git commit -m "test(workflow-lint): broken-workflow corpus"`

---

### Task 15: CLI

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts` (runs the built CLI via `node dist/cli.js` — build first in the test's `beforeAll` via `execFileSync('pnpm', ['build'])`, or test the exported `runCli(argv, stdout)` function directly and keep one smoke on the built file)

**Interfaces:**
- Usage: `workflow lint <file...> [--json] [--quiet]`. Unknown subcommand / no files → usage on stderr, exit 2. Missing file → error finding for that path, exit 2.
- Exit codes: 0 = no errors/warnings (notices allowed), 1 = any error or warning, 2 = usage/IO error.
- Human output (eslint-shaped, per file):

```
apps/workflow/docs/spec/examples/hello.workflow.yaml
  62:9  notice  outputs-omitted  pipeline step `boom` declares no outputs — it will expose outputs.response (json)

✔ 2 files: 0 errors, 0 warnings, 1 notice
```

with `hint:` printed indented under a finding when present; `--quiet` hides notices.
- JSON output (`--json`): `{ "version": 1, "files": [{ "file", "findings": [Finding…], "counts" }], "summary": { "errors", "warnings", "notices" } }` — one stable shape for the future `bffless workflows lint` wrapper.

- [ ] **Step 1: Write failing tests** — clean file → exit 0; corpus file → exit 1, human output contains `rule` and `line:col`; `--json` parses and `summary.errors` > 0; missing file → exit 2; `workflow frobnicate` → exit 2 + usage.
- [ ] **Step 2–4: Red → implement (hand-rolled argv loop, no dep) → green**
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow-lint): workflow lint CLI with human and JSON reporters"`

---

### Task 16: CI workflow, README, final verification, PR

**Files:**
- Create: `.github/workflows/workflow-lint.yml`, `packages/workflow-lint/README.md`

- [ ] **Step 1: CI workflow** — mirrors `app-conventions.yml` mechanics (pnpm/action-setup@v4, setup-node@v4 node 20 + pnpm cache, `pnpm install --frozen-lockfile`):

```yaml
name: workflow-lint
on:
  pull_request:
    paths:
      - 'packages/workflow-lint/**'
      - 'apps/workflow/docs/spec/workflow.schema.json'
      - 'apps/workflow/docs/spec/examples/**'
      - '.github/workflows/workflow-lint.yml'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @bffless/workflow-lint build
      - run: pnpm --filter @bffless/workflow-lint lint
      - run: pnpm --filter @bffless/workflow-lint test:run
      - name: Lint the spec examples with the built CLI
        run: node packages/workflow-lint/dist/cli.js lint apps/workflow/docs/spec/examples/hello.workflow.yaml apps/workflow/docs/spec/examples/studio.workflow.yaml
```

- [ ] **Step 2: README** — what it is (M0 prototype per 00-overview), the rule table from this plan (id / severity / one-liner / spec source), CLI usage + exit codes, the severity policy, the M1 reuse contract (`@bffless/workflow-lint/expressions`, `/definition`), the schema-copy drift fence, and "the future `bffless workflows lint` verb wraps `lintFile`".

- [ ] **Step 3: Full verification** (superpowers:verification-before-completion — run these, read the output):

```bash
pnpm --filter @bffless/workflow-lint build && pnpm --filter @bffless/workflow-lint lint && pnpm --filter @bffless/workflow-lint test:run
node packages/workflow-lint/dist/cli.js lint apps/workflow/docs/spec/examples/*.workflow.yaml; echo "exit: $?"   # expect 0
node scripts/check-app-conventions.mjs      # workflow still listed as spec-only, all apps still pass
```

- [ ] **Step 4: Commit + push everything, then open the PR** (push BEFORE `gh pr create` — user merges fast)

```bash
git add -A && git commit -m "chore(workflow-lint): CI workflow and README"
git push -u origin feat/workflow-lint-m0
gh pr create --title "feat(workflow-lint): workflow lint prototype for M0" --body-file - <<'EOF'
[summary: what shipped, rule table, placement rationale (packages/, apps/workflow stays spec-only until M1), how to run]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Do **not** merge; report the PR URL and stop.

---

## Self-review notes

- **Spec coverage:** every item in the user's scope maps to a task — schema+ajv (T7), expression parser/evaluator incl. length/pluck/dynamic-index/null-propagation/quoting-hint (T2–T6), all six 09 checks (T10 upstream, T11 render/paths/body, T12 headless-skip + interactive-notice), CLI human+JSON+exit codes (T15), examples clean (T13), broken corpus (T14). The two prose-mandated extras (`outputs-omitted`, `untyped-job-output`) are notices so hello stays clean.
- **Out of scope, deliberately:** evaluation of matrix expressions at lint time (no run data), `index.json` `headlessSafe` marking (M1 discovery), publishing to npm, the `bffless` CLI verb itself, object filters (`a.*.b` — not in the spec's subset).
- **Type-consistency:** `Finding`/`ExprSite`/`Slot`/`VType` signatures are defined once (T2/T8/T11) and consumed by name in T9–T15.
