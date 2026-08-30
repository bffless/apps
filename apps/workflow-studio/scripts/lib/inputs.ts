/**
 * The `ctx.inputs` guards the six `script` modules share.
 *
 * A `script` step's inputs are the workflow YAML's `with` keys after expression
 * evaluation, so they arrive as `unknown` — a mistyped expression, a pipeline that
 * answered a shape nobody expected, or a resumed run replaying an older definition
 * all show up here rather than at build time. The harness reports a thrown script as
 * a failed step with the message attached (spec 03), so a precise `Error` naming the
 * script and the offending key is the useful failure; silently coercing is not.
 *
 * Everything here is pure and DOM-free — these run inside the Worker.
 */
import type { Cut, Scene } from 'studio/lib/scenes'
import type { TWord } from 'studio/lib/transcriptGrid'
import type { FileRef } from '@bffless/workflow-script'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** `<script>: \`<key>\` <expectation>` — the one message shape every guard throws. */
export function inputError(script: string, key: string, expectation: string): Error {
  return new Error(`${script}: \`${key}\` ${expectation}`)
}

/** A finite number. Rejects a numeric string — the YAML's `${{ }}` keeps types. */
export function requireNumber(script: string, inputs: Record<string, unknown>, key: string): number {
  const v = inputs[key]
  if (typeof v !== 'number') throw inputError(script, key, 'must be a number')
  return v
}

/** A string; `''` is legitimate (an empty post, an untitled video). */
export function requireString(script: string, inputs: Record<string, unknown>, key: string): string {
  const v = inputs[key]
  if (typeof v !== 'string') throw inputError(script, key, 'must be a string')
  return v
}

/** An array — element shapes are the caller's business. */
export function requireArray(script: string, inputs: Record<string, unknown>, key: string): unknown[] {
  const v = inputs[key]
  if (!Array.isArray(v)) throw inputError(script, key, 'must be a list')
  return v
}

/** A plain object map (an array is NOT one — `byTime` arriving as `[]` is a real
 *  failure mode when the frames pipeline returns nothing). */
export function requireRecord(
  script: string,
  inputs: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const v = inputs[key]
  if (!isRecord(v)) throw inputError(script, key, 'must be an object map')
  return v
}

/** A list of finite numbers, e.g. the per-source `durations`. */
export function requireNumbers(script: string, inputs: Record<string, unknown>, key: string): number[] {
  const list = requireArray(script, inputs, key)
  return list.map((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw inputError(script, key, 'must be a list of finite numbers')
    }
    return v
  })
}

/** A list of harness File refs (`{ path, name, contentType, size, url }`). Only
 *  `path`/`name` are load-bearing here, but a bare path string means an upstream
 *  step declared the wrong output type — worth failing loudly. */
export function requireFileRefs(
  script: string,
  inputs: Record<string, unknown>,
  key: string,
): FileRef[] {
  const list = requireArray(script, inputs, key)
  return list.map((v) => {
    if (!isRecord(v) || typeof v.path !== 'string' || !v.path) {
      throw inputError(script, key, 'must be a list of File refs')
    }
    return v as unknown as FileRef
  })
}

// ---- Scene rows -----------------------------------------------------------

/**
 * One row of the director's `scenes` table — what `rules/scenes/post/parse.fn.js`
 * emits and the workflow carries as `needs.director.outputs.scenes`. `start`/`end`
 * are LOCAL to `source` (R130 keeps the keys camelCase; the rule is the contract).
 */
export type SceneRow = {
  number: number
  title: string
  brief: string
  source: string
  sourceIndex: number
  start: number
  end: number
  spans: Cut[]
  cuts: Cut[]
  /** Only present when a legacy director row echoed the words back. `sceneTail`'s
   *  fallback when the caller has no word list for the row. */
  transcript?: string
}

const spans = (v: unknown): Cut[] =>
  Array.isArray(v)
    ? v.flatMap((s) =>
        isRecord(s) && typeof s.start === 'number' && typeof s.end === 'number'
          ? [{ start: s.start, end: s.end }]
          : [],
      )
    : []

/** Coerce one director row, or throw. */
export function toSceneRow(script: string, key: string, v: unknown): SceneRow {
  if (
    !isRecord(v) ||
    typeof v.number !== 'number' ||
    typeof v.start !== 'number' ||
    typeof v.end !== 'number'
  ) {
    throw inputError(script, key, 'must be a director scene row (`{ number, start, end, … }`)')
  }
  return {
    number: v.number,
    title: typeof v.title === 'string' ? v.title : '',
    brief: typeof v.brief === 'string' ? v.brief : '',
    source: typeof v.source === 'string' ? v.source : '',
    sourceIndex: typeof v.sourceIndex === 'number' ? v.sourceIndex : 0,
    start: v.start,
    end: v.end,
    spans: spans(v.spans),
    cuts: spans(v.cuts),
    ...(typeof v.transcript === 'string' ? { transcript: v.transcript } : {}),
  }
}

/** The whole `scenes` list, coerced row by row. */
export function requireSceneRows(
  script: string,
  inputs: Record<string, unknown>,
  key: string,
): SceneRow[] {
  return requireArray(script, inputs, key).map((v) => toSceneRow(script, key, v))
}

/** A WhisperX word list (`transcribe`'s `words` output). A word missing a finite
 *  `start` is dropped — `sceneWordTimings` would skip it anyway, and dropping it
 *  here keeps the midpoint arithmetic below honest. */
export function requireWords(
  script: string,
  inputs: Record<string, unknown>,
  key: string,
): TWord[] {
  return toWords(script, key, inputs[key])
}

/** `requireWords` over an already-extracted value (the per-scene lists of `final-script`). */
export function toWords(script: string, key: string, v: unknown): TWord[] {
  if (!Array.isArray(v)) throw inputError(script, key, 'must be a list of transcript words')
  const out: TWord[] = []
  for (const w of v) {
    if (!isRecord(w)) throw inputError(script, key, 'must be a list of transcript words')
    const start = w.start
    if (typeof start !== 'number' || !Number.isFinite(start)) continue
    const end = typeof w.end === 'number' && Number.isFinite(w.end) ? w.end : start
    out.push({ text: typeof w.text === 'string' ? w.text : '', start, end })
  }
  return out
}

/**
 * A director row as the `Scene` Studio's pure helpers take. Only the fields those
 * helpers actually read carry meaning:
 *
 * - `start`/`end` — the scene window, in its source's LOCAL seconds (`sceneVideoSeconds`).
 * - `cuts` — what `effectiveCuts` returns (there is never a `refined` here: the
 *   workflow's refiner output travels as the `refine`/`trim` step's own `cuts`,
 *   which the caller passes in through `cuts` rather than storing on the row).
 * - `transcript` — `sceneTail`'s and `videoScript`'s fallback when no words are known.
 * - `title` — the chapter name `videoChapters` emits.
 *
 * `id`/`index`/`sourceId`/`status` are structural: `Scene` requires them and nothing
 * in `refiner.ts`/`describe.ts` reads them (the words lookup is by identity here, not
 * by `sourceId`), so they get faithful-but-inert values.
 */
export function toScene(row: SceneRow, cuts: Cut[] = row.cuts): Scene {
  return {
    id: `scene-${row.number}`,
    index: row.number - 1,
    sourceId: row.source,
    title: row.title,
    start: row.start,
    end: row.end,
    transcript: row.transcript ?? '',
    status: 'pending',
    cuts,
  }
}
