import type { Expr, ExprSyntaxError } from '../expressions/ast.js'
import { isSingleExpression, parseIfExpression, scanTemplates } from '../expressions/template.js'
import type { Definition, Job, Step, StepKind } from './definition.js'

export interface Slot {
  where:
    | 'job-if'
    | 'job-output'
    | 'matrix'
    | 'step-if'
    | 'with'
    | 'body'
    | 'query'
    | 'poll'
    | 'poll-query'
    | 'poll-body'
    | 'retry-if'
    | 'step-output-value'
    | 'summary'
    | 'annotation-if'
    | 'annotation-message'
    | 'headless-output'
    | 'top-output'
  jobId?: string
  stepIndex?: number
  stepId?: string
  stepUses?: StepKind
  /** Status functions are legal here. */
  isIf: boolean
}

export interface ExprSite {
  expr?: Expr
  parseError?: ExprSyntaxError
  /** The expression source between the ${{ }} markers (or the whole bare if). */
  raw: string
  /** JSON pointer to the containing scalar. */
  pointer: string
  slot: Slot
  /** The scalar is exactly this one expression (value keeps its type). */
  isWholeValue: boolean
}

const IF_SLOTS = new Set<Slot['where']>(['job-if', 'step-if', 'retry-if', 'annotation-if'])

function esc(seg: string | number): string {
  return String(seg).replaceAll('~', '~0').replaceAll('/', '~1')
}

export function collectSites(def: Definition): ExprSite[] {
  const sites: ExprSite[] = []

  function addScalar(value: string, pointer: string, slot: Slot): void {
    if (slot.isIf && IF_SLOTS.has(slot.where)) {
      const whole = isSingleExpression(value) || !value.includes('${{')
      for (const s of parseIfExpression(value).spans) {
        sites.push({
          expr: s.expr,
          parseError: s.error,
          raw: s.src,
          pointer,
          slot,
          isWholeValue: whole,
        })
      }
      return
    }
    const spans = scanTemplates(value)
    if (spans.length === 0) return
    const whole = isSingleExpression(value)
    for (const s of spans) {
      sites.push({
        expr: s.expr,
        parseError: s.error,
        raw: s.src,
        pointer,
        slot,
        isWholeValue: whole && spans.length === 1,
      })
    }
  }

  /** Recurse through nested objects/arrays collecting every string scalar. */
  function walkValue(value: unknown, pointer: string, slot: Slot): void {
    if (typeof value === 'string') {
      addScalar(value, pointer, slot)
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walkValue(v, `${pointer}/${i}`, slot))
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walkValue(v, `${pointer}/${esc(k)}`, slot)
    }
  }

  function walkOutputMap(
    outputs: Record<string, unknown> | undefined,
    pointer: string,
    slot: Slot,
  ): void {
    if (!outputs) return
    for (const [name, decl] of Object.entries(outputs)) {
      const p = `${pointer}/${esc(name)}`
      if (typeof decl === 'string') {
        addScalar(decl, p, slot)
      } else if (decl !== null && typeof decl === 'object') {
        const d = decl as Record<string, unknown>
        if (d.value !== undefined) walkValue(d.value, `${p}/value`, slot)
        if (d.options !== undefined) walkValue(d.options, `${p}/options`, slot)
      }
    }
  }

  function walkStep(job: Job, step: Step, basePointer: string): void {
    const base = { jobId: job.id, stepIndex: step.index, stepId: step.id, stepUses: step.uses }
    const slot = (where: Slot['where'], isIf = false): Slot => ({ where, isIf, ...base })
    const raw = step.raw

    if (typeof raw.if === 'string') addScalar(raw.if, `${basePointer}/if`, slot('step-if', true))

    const w = raw.with
    if (w != null && typeof w === 'object') {
      for (const [k, v] of Object.entries<unknown>(w)) {
        const p = `${basePointer}/with/${esc(k)}`
        if (step.uses === 'pipeline' && k === 'body') walkValue(v, p, slot('body'))
        else if (step.uses === 'pipeline' && k === 'query') walkValue(v, p, slot('query'))
        else if (step.uses === 'form' && k === 'fields') {
          for (const [fname, fdef] of Object.entries<any>(v ?? {})) {
            const fp = `${p}/${esc(fname)}`
            if (fdef?.default !== undefined) walkValue(fdef.default, `${fp}/default`, slot('with'))
            if (fdef?.options !== undefined) walkValue(fdef.options, `${fp}/options`, slot('with'))
          }
        } else walkValue(v, p, slot('with'))
      }
    }

    const poll = raw.poll
    if (poll != null && typeof poll === 'object') {
      const p = `${basePointer}/poll`
      if (typeof poll.path === 'string') addScalar(poll.path, `${p}/path`, slot('with'))
      walkValue(poll.query, `${p}/query`, slot('poll-query'))
      walkValue(poll.body, `${p}/body`, slot('poll-body'))
      if (typeof poll.until === 'string') addScalar(poll.until, `${p}/until`, slot('poll'))
      if (typeof poll.fail === 'string') addScalar(poll.fail, `${p}/fail`, slot('poll'))
    }

    if (typeof raw.retry?.if === 'string') {
      addScalar(raw.retry.if, `${basePointer}/retry/if`, slot('retry-if', true))
    }

    walkOutputMap(raw.outputs, `${basePointer}/outputs`, slot('step-output-value'))

    if (typeof raw.summary === 'string') {
      addScalar(raw.summary, `${basePointer}/summary`, slot('summary'))
    }

    if (Array.isArray(raw.annotations)) {
      raw.annotations.forEach((a: any, i: number) => {
        const p = `${basePointer}/annotations/${i}`
        if (typeof a?.if === 'string') addScalar(a.if, `${p}/if`, slot('annotation-if', true))
        if (typeof a?.message === 'string') addScalar(a.message, `${p}/message`, slot('annotation-message'))
        if (typeof a?.title === 'string') addScalar(a.title, `${p}/title`, slot('annotation-message'))
      })
    }

    const headless = raw.headless
    if (headless != null && typeof headless === 'object' && headless.outputs != null) {
      walkValue(headless.outputs, `${basePointer}/headless/outputs`, slot('headless-output'))
    }
  }

  for (const job of Object.values(def.jobs)) {
    const jp = `/jobs/${esc(job.id)}`
    if (typeof job.if === 'string') {
      addScalar(job.if, `${jp}/if`, { where: 'job-if', isIf: true, jobId: job.id })
    }
    if (job.matrix) {
      for (const [v, val] of Object.entries(job.matrix)) {
        walkValue(val, `${jp}/strategy/matrix/${esc(v)}`, { where: 'matrix', isIf: false, jobId: job.id })
      }
    }
    job.steps.forEach((step) => walkStep(job, step, `${jp}/steps/${step.index}`))
    walkOutputMap(job.outputs, `${jp}/outputs`, { where: 'job-output', isIf: false, jobId: job.id })
  }

  walkOutputMap(def.outputs, '/outputs', { where: 'top-output', isIf: false })

  return sites
}
