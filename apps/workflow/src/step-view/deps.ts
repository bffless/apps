/**
 * The step view's bridge (spec 10 §Islands and forms inside an agent host;
 * Phase 2 plan, Decisions 3–4; Phase 4 plan, Decisions 2–3): how one waiting step's every
 * capability rides the outer MCP Apps bridge as `tools/call` to the harness's
 * own endpoint.
 *
 * Inward the view is the harness's `IslandHost` (the island cannot tell which
 * host it is in); outward it is an ext-apps `App`, and the four app-only tools
 * — `workflow.stepView`, `workflow.pipeline`, `workflow.submit`,
 * `workflow.annotate` — plus the catalog's `workflow.sign` and, for a form
 * step, `workflow.submitStep` are the whole surface. The fence still holds
 * server-side: `workflow.pipeline` resolves a name against the *run's*
 * implementation, never against anything the view says. Pure: no DOM, so
 * `deps.test.ts` drives it with a recording `call`.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { InputDef } from '@bffless/workflow-lint/definition'
import type { IslandHostDeps, SubmitAnswer } from '../islands/IslandHost'
import { resolveSrc } from '../lib/runner/adapters/island'
import { isFileRefLike } from '../lib/runner/fileRef'
import type { FileRef } from '../lib/runner/types'

/** `App.callServerTool`, narrowed to what the view sends. */
export type ServerCall = (params: { name: string; arguments: Record<string, unknown> }) => Promise<CallToolResult>

interface StepViewBase {
  runId: string
  step: string
  impl: string
  workflow: string
  status: string
}

/** What `workflow.stepView` answers for an island: enough to mount it exactly as the harness page would. */
export interface IslandStepView extends StepViewBase {
  kind: 'island'
  src: string
  arguments: Record<string, unknown>
  outputs?: Record<string, unknown>
  html: string
}

/** …and for a form (Phase 4, Decision 2): the fields the harness evaluated when the step started waiting, off the row. */
export interface FormStepView extends StepViewBase {
  kind: 'form'
  title: string
  description?: string
  submit: string
  fields: Record<string, InputDef>
  initial: Record<string, unknown>
}

export type StepViewData = IslandStepView | FormStepView

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The text blocks of a tool result, joined — how a refusal reads. */
export function resultText(result: CallToolResult): string {
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

/** The `workflow.stepView` result, validated; throws with the result's text on a refusal or a malformed answer. */
export function readStepView(result: CallToolResult): StepViewData {
  if (result.isError) throw new Error(resultText(result) || 'workflow.stepView refused')
  const s = isPlainObject(result.structuredContent) ? result.structuredContent : {}
  const str = (key: string) => (typeof s[key] === 'string' ? (s[key] as string) : '')
  const base: StepViewBase = { runId: str('runId'), step: str('step'), impl: str('impl'), workflow: str('workflow'), status: str('status') }
  for (const key of ['runId', 'step', 'impl'] as const) {
    if (base[key] === '') throw new Error(`workflow.stepView answered without ${key}`)
  }
  if (str('kind') === 'form') {
    if (!isPlainObject(s.fields)) throw new Error('workflow.stepView answered without fields')
    return {
      ...base,
      kind: 'form',
      title: str('title') || base.step,
      ...(str('description') === '' ? {} : { description: str('description') }),
      submit: str('submit') || 'Submit',
      fields: s.fields as Record<string, InputDef>,
      initial: isPlainObject(s.initial) ? s.initial : {},
    }
  }
  const view: IslandStepView = {
    ...base,
    kind: 'island',
    src: str('src'),
    arguments: isPlainObject(s.arguments) ? s.arguments : {},
    ...(isPlainObject(s.outputs) ? { outputs: s.outputs } : {}),
    html: str('html'),
  }
  for (const key of ['src', 'html'] as const) {
    if (view[key] === '') throw new Error(`workflow.stepView answered without ${key}`)
  }
  return view
}

/** A form's submit over the bridge: `workflow.submitStep { runId, step, values }`, the verdict read as the island path reads `workflow.submit`'s (Decision 3). */
export async function submitFormValues(call: ServerCall, view: FormStepView, values: Record<string, unknown>): Promise<SubmitAnswer> {
  const result = await call({ name: 'workflow.submitStep', arguments: { runId: view.runId, step: view.step, values } })
  if (!result.isError) return { ok: true }
  const s = isPlainObject(result.structuredContent) ? result.structuredContent : {}
  const errors = isPlainObject(s.errors)
    ? Object.fromEntries(Object.entries(s.errors).map(([key, value]) => [key, String(value)]))
    : { values: resultText(result) || 'workflow.submitStep refused' }
  return { ok: false, errors }
}

/** One `workflow.sign` round trip for a form preview; `null` on any refusal or malformed answer, so the caller can leave the option as it was. */
async function signRef(call: ServerCall, runId: string, ref: FileRef): Promise<string | null> {
  const result = await call({ name: 'workflow.sign', arguments: { runId, path: ref.path } })
  if (result.isError) return null
  const s = isPlainObject(result.structuredContent) ? result.structuredContent : {}
  return typeof s.url === 'string' && s.url !== '' ? s.url : null
}

/**
 * Task 3c (spec 10 D6): a form's File-ref previews carry the harness page's
 * ordinary `url` — same-origin relative to *that* page — which resolves
 * against the wrong origin and carries no cookie inside an agent host's
 * sandbox. `main.tsx` calls this before rendering the form, re-pointing every
 * File-ref preview at a presigned GET the sandbox may load: a `choice`
 * field's File-ref `options` entries, a File-ref `options` entry's `preview`,
 * and — Task 3c fix round 1 — a `file` field's own prefilled File ref(s) in
 * `initial` (e.g. a `default` pointing at an upstream output), one per
 * element when `list: true`. `path` is untouched everywhere, since it — not
 * `url` — is the value a tile or a file field submits. Signing is sequential
 * on purpose: a form has a handful of previews and the bridge is one channel.
 * A refused sign leaves that ref exactly as it was, so a broken preview
 * degrades to whatever the page already renders for an unloadable url rather
 * than failing the whole form. The input `view` is read only — every
 * returned collection (`fields`, `initial`) is a fresh object.
 *
 * The `file`-field pass also returns `canonical`: `signed url -> original
 * url`. A `file` field's value is submitted verbatim (unlike `choice`, which
 * submits `path`), so a prefilled ref the person never touched would
 * otherwise ride the presigned GET straight into the step's outputs — an
 * expiring `storage.googleapis.com/...?X-Goog-Signature=` url, not the file's
 * real one. `main.tsx`'s submit restores the original before calling
 * `submitFormValues` (`canonicalizeFileValues` below).
 */
export async function signFormPreviews(
  call: ServerCall,
  view: FormStepView,
): Promise<{ view: FormStepView; signed: string[]; canonical: Record<string, string> }> {
  const signed: string[] = []
  const canonical: Record<string, string> = {}
  const fields: Record<string, InputDef> = {}
  for (const [name, field] of Object.entries(view.fields)) {
    if (!Array.isArray(field.options)) {
      fields[name] = field
      continue
    }
    const options: unknown[] = []
    for (const option of field.options) {
      if (isFileRefLike(option)) {
        const url = await signRef(call, view.runId, option)
        if (url) signed.push(url)
        options.push(url ? { ...option, url } : option)
      } else if (isPlainObject(option) && isFileRefLike(option.preview)) {
        const url = await signRef(call, view.runId, option.preview)
        if (url) signed.push(url)
        options.push(url ? { ...option, preview: { ...option.preview, url } } : option)
      } else {
        options.push(option)
      }
    }
    fields[name] = { ...field, options } as InputDef
  }

  const initial: Record<string, unknown> = { ...view.initial }
  for (const [name, field] of Object.entries(view.fields)) {
    if (field.type !== 'file') continue
    const value = view.initial[name]
    if (field.list === true) {
      if (!Array.isArray(value)) continue
      const items: unknown[] = []
      for (const item of value) {
        if (!isFileRefLike(item)) {
          items.push(item)
          continue
        }
        const url = await signRef(call, view.runId, item)
        if (url) {
          signed.push(url)
          canonical[url] = item.url
        }
        items.push(url ? { ...item, url } : item)
      }
      initial[name] = items
    } else if (isFileRefLike(value)) {
      const url = await signRef(call, view.runId, value)
      if (url) {
        signed.push(url)
        canonical[url] = value.url
      }
      initial[name] = url ? { ...value, url } : value
    }
  }

  return { view: { ...view, fields, initial }, signed, canonical }
}

/**
 * The inverse of the `file`-field half of `signFormPreviews`, applied just
 * before a form submits: for every `file` field's value (single, or each
 * element when `list: true`) whose `url` is a key of `canonical`, restore the
 * original `url` — the ref `signFormPreviews` started from — before
 * `submitFormValues` sends it. A value the person changed (a fresh upload is
 * refused, so in practice: left untouched or cleared) carries no signed url
 * and passes through unchanged. Exported so `deps.test.ts` can drive the
 * restore without a DOM.
 */
export function canonicalizeFileValues(
  values: Record<string, unknown>,
  fields: Record<string, InputDef>,
  canonical: Record<string, string>,
): Record<string, unknown> {
  if (Object.keys(canonical).length === 0) return values
  const restoreOne = (v: unknown): unknown => {
    if (!isFileRefLike(v)) return v
    const original = canonical[v.url]
    return original === undefined ? v : { ...v, url: original }
  }

  const restored: Record<string, unknown> = { ...values }
  for (const [name, field] of Object.entries(fields)) {
    if (field.type !== 'file' || !(name in values)) continue
    const value = values[name]
    restored[name] = field.list === true && Array.isArray(value) ? value.map(restoreOne) : restoreOne(value)
  }
  return restored
}

/** `_meta.bffless.status` of a pipeline answer the endpoint relayed, when it carried one. */
function relayedStatus(result: CallToolResult): number | undefined {
  const meta = isPlainObject(result._meta) ? result._meta : {}
  const bffless = isPlainObject(meta.bffless) ? meta.bffless : {}
  return typeof bffless.status === 'number' ? bffless.status : undefined
}

export interface StepViewHooks {
  /** `ui/message` and logging from the island — the view shows the last line. */
  onLog(line: string): void
  /** The island's `workflow.submit` was accepted server-side. */
  onSubmitted(): void
}

/**
 * `IslandHostDeps` for one waiting step, every capability over `call`:
 * - `http` (the island's pipeline tools, which `IslandHost` has already fenced
 *   to `/api/<impl>/<path>`) → `workflow.pipeline { runId, step, name: path,
 *   arguments, method }`; the endpoint re-fences `name` against the run's impl;
 * - `fetchText` answers the island's own URL with the HTML `stepView` carried
 *   (the frame is mounted from text, like on the page) and nothing else — a
 *   sibling asset is not reachable from inside an agent host in this phase;
 * - `onSubmit` → `workflow.submit { runId, step, outputs }`, a refusal's
 *   `structuredContent.errors` handed back per output as the page would;
 * - `onAnnotate` → `workflow.annotate { runId, step, ...args }`;
 * - `sign` → the catalog's `workflow.sign { runId, path }`.
 */
export function stepViewDeps(call: ServerCall, view: IslandStepView, hooks: StepViewHooks): IslandHostDeps {
  const islandUrl = resolveSrc(view.impl, view.src)
  const scoped = { runId: view.runId, step: view.step }

  return {
    async http(url, init) {
      const prefix = `/api/${view.impl}/`
      const name = url.startsWith(prefix) ? url.slice(prefix.length) : url
      const method = init.method === 'GET' ? 'GET' : 'POST'
      const args = method === 'GET' ? (init.query ?? {}) : (init.body ?? {})
      const result = await call({ name: 'workflow.pipeline', arguments: { ...scoped, name, arguments: args, method } })
      if (result.isError) {
        return { ok: false, status: relayedStatus(result) ?? 500, body: { error: resultText(result) } }
      }
      return { ok: true, status: relayedStatus(result) ?? 200, body: result.structuredContent ?? {} }
    },

    async fetchText(url) {
      if (url === islandUrl) return { ok: true, status: 200, text: view.html }
      return { ok: false, status: 404, text: `${url}: only the island's own file is available inside an agent host` }
    },

    async onSubmit(outputs) {
      const result = await call({ name: 'workflow.submit', arguments: { ...scoped, outputs } })
      if (result.isError) {
        const s = isPlainObject(result.structuredContent) ? result.structuredContent : {}
        const errors = isPlainObject(s.errors)
          ? Object.fromEntries(Object.entries(s.errors).map(([key, value]) => [key, String(value)]))
          : { outputs: resultText(result) || 'workflow.submit refused' }
        return { ok: false, errors }
      }
      hooks.onSubmitted()
      return { ok: true }
    },

    async onAnnotate(args) {
      const extra = isPlainObject(args) ? args : {}
      const result = await call({ name: 'workflow.annotate', arguments: { ...scoped, ...extra } })
      if (result.isError) return { ok: false, error: resultText(result) || 'workflow.annotate refused' }
      return { ok: true }
    },

    async sign(path) {
      const result = await call({ name: 'workflow.sign', arguments: { runId: view.runId, path } })
      if (result.isError) throw new Error(resultText(result) || 'workflow.sign refused')
      const s = isPlainObject(result.structuredContent) ? result.structuredContent : {}
      if (typeof s.url !== 'string' || s.url === '') throw new Error(`${path}: the sign tool returned no url`)
      return { url: s.url, expiresIn: typeof s.expiresIn === 'number' ? s.expiresIn : 3600 }
    },

    onDisplayMode: () => {},
    onLog: hooks.onLog,
    openLink: () => {},
    now: () => Date.now(),
  }
}
