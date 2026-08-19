import type { Expr } from '../expressions/ast.js'
import { isSingleExpression, scanTemplates } from '../expressions/template.js'
import type { Definition, Job, OutputDecl } from './definition.js'

/** A statically-inferred value type: a base from 02's vocabulary + list nesting depth. */
export interface VType {
  base:
    | 'string'
    | 'number'
    | 'boolean'
    | 'choice'
    | 'file'
    | 'table'
    | 'markdown'
    | 'json'
    | 'unknown'
  list: number
}

const UNKNOWN: VType = { base: 'unknown', list: 0 }

/** File-ref scalar members (02). */
const FILE_MEMBERS: Record<string, VType['base']> = {
  path: 'string',
  name: 'string',
  contentType: 'string',
  url: 'string',
  size: 'number',
}

function fromDecl(decl: { type?: string; list?: boolean } | undefined): VType {
  if (!decl?.type) return UNKNOWN
  return { base: decl.type as VType['base'], list: decl.list ? 1 : 0 }
}

/** Descend one property/index segment into a type. */
function descend(t: VType, seg: string | null): VType {
  if (t.base === 'unknown' && t.list === 0) return UNKNOWN
  if (t.list > 0) {
    // any segment on a list reads an element (numeric or dynamic index)
    if (seg === null || /^\d+$/.test(seg ?? '')) return { ...t, list: t.list - 1 }
    return UNKNOWN
  }
  if (seg !== null && t.base === 'file') {
    const base = FILE_MEMBERS[seg]
    return base ? { base, list: 0 } : UNKNOWN
  }
  return UNKNOWN
}

function chainOf(e: Expr): { root: string; path: (string | null)[] } | undefined {
  if (e.kind === 'ident') return { root: e.name, path: [] }
  if (e.kind === 'member') {
    const c = chainOf(e.object)
    return c && { root: c.root, path: [...c.path, e.property] }
  }
  if (e.kind === 'index') {
    const c = chainOf(e.object)
    if (!c) return undefined
    const idx = e.index
    const seg = idx.kind === 'string' ? idx.value : idx.kind === 'number' ? String(idx.value) : null
    return { root: c.root, path: [...c.path, seg] }
  }
  return undefined
}

export class TypeEnv {
  constructor(private def: Definition) {}

  /** Type of a step output by declaration (03's per-kind conventions). */
  private stepOutputType(job: Job, stepId: string, name: string, depth: number): VType {
    const step = job.steps.find((s) => s.id === stepId)
    if (!step) return UNKNOWN
    if (step.uses === 'form') return fromDecl(step.raw.with?.fields?.[name])
    const decl = step.raw.outputs?.[name]
    if (decl) return fromDecl(decl)
    if (step.uses === 'pipeline' && name === 'response') return { base: 'json', list: 0 }
    return UNKNOWN
  }

  /** Declared (or inferred-from-bare-reference) type of a job output, matrix-lifted. */
  jobOutputType(job: Job, name: string, depth = 0): VType {
    const decl: OutputDecl | undefined = job.outputs[name]
    if (decl === undefined || depth > 8) return UNKNOWN
    let t: VType
    if (typeof decl === 'string') {
      // bare expression: a direct reference keeps its type, anything else is json (01)
      t = isSingleExpression(decl)
        ? this.infer(scanTemplates(decl)[0]?.expr, job, depth + 1)
        : { base: 'json', list: 0 }
      if (t.base === 'unknown') t = { base: 'json', list: t.list }
    } else {
      t = fromDecl(decl)
    }
    return job.matrix ? { ...t, list: t.list + 1 } : t
  }

  private matrixVarType(job: Job, name: string, depth: number): VType {
    const src = job.matrix?.[name]
    if (typeof src === 'string' && isSingleExpression(src)) {
      const t = this.infer(scanTemplates(src)[0]?.expr, job, depth + 1)
      return t.list > 0 ? { ...t, list: t.list - 1 } : UNKNOWN
    }
    return UNKNOWN
  }

  /**
   * Infer the type of an expression evaluated inside `job` (undefined for
   * top-level outputs). Conservative: `unknown` whenever unsure.
   */
  infer(expr: Expr | undefined, job: Job | undefined, depth = 0): VType {
    if (!expr || depth > 16) return UNKNOWN
    switch (expr.kind) {
      case 'string':
        return { base: 'string', list: 0 }
      case 'number':
        return { base: 'number', list: 0 }
      case 'true':
      case 'false':
        return { base: 'boolean', list: 0 }
      case 'null':
        return UNKNOWN
      case 'not':
        return { base: 'boolean', list: 0 }
      case 'binary':
        if (expr.op === '&&' || expr.op === '||') return UNKNOWN
        return { base: 'boolean', list: 0 }
      case 'call': {
        const name = expr.callee.toLowerCase()
        if (name === 'length') return { base: 'number', list: 0 }
        if (name === 'fromjson') return { base: 'json', list: 0 }
        if (name === 'tojson' || name === 'format' || name === 'join') return { base: 'string', list: 0 }
        if (name === 'contains' || name === 'startswith' || name === 'endswith') {
          return { base: 'boolean', list: 0 }
        }
        if (name === 'pluck') {
          const src = this.infer(expr.args[0], job, depth + 1)
          if (src.list === 0) return UNKNOWN
          // plucking projects each element to a scalar member; file members are scalars
          const key = expr.args[1]
          const seg = key?.kind === 'string' ? key.value : null
          const elemBase = src.base === 'file' && seg ? (FILE_MEMBERS[seg] ?? 'unknown') : 'unknown'
          return { base: elemBase, list: src.list }
        }
        return UNKNOWN
      }
      case 'ident':
      case 'member':
      case 'index': {
        const c = chainOf(expr)
        if (!c) return UNKNOWN
        return this.chainType(c.root, c.path, job, depth)
      }
    }
  }

  private chainType(root: string, path: (string | null)[], job: Job | undefined, depth: number): VType {
    if (root === 'inputs') {
      const [name, ...rest] = path
      if (typeof name !== 'string') return UNKNOWN
      let t = fromDecl(this.def.inputs[name])
      // a choice field's value is its option string (02)
      if (t.base === 'choice') t = { base: 'string', list: t.list }
      for (const seg of rest) t = descend(t, seg)
      return t
    }
    if (root === 'matrix' && job) {
      const [name, ...rest] = path
      if (typeof name !== 'string') return UNKNOWN
      let t = this.matrixVarType(job, name, depth)
      for (const seg of rest) t = descend(t, seg)
      return t
    }
    if (root === 'steps' && job) {
      const [stepId, kind, name, ...rest] = path
      if (typeof stepId !== 'string' || kind !== 'outputs' || typeof name !== 'string') return UNKNOWN
      let t = this.stepOutputType(job, stepId, name, depth)
      if (t.base === 'choice') t = { base: 'string', list: t.list }
      for (const seg of rest) t = descend(t, seg)
      return t
    }
    if (root === 'needs' && job) {
      const [jobId, kind, name, ...rest] = path
      if (typeof jobId !== 'string' || kind !== 'outputs' || typeof name !== 'string') return UNKNOWN
      const target = this.def.jobs[jobId]
      if (!target) return UNKNOWN
      let t = this.jobOutputType(target, name, depth + 1)
      if (t.base === 'choice') t = { base: 'string', list: t.list }
      for (const seg of rest) t = descend(t, seg)
      return t
    }
    if (root === 'jobs') {
      const [jobId, kind, name, ...rest] = path
      if (typeof jobId !== 'string' || kind !== 'outputs' || typeof name !== 'string') return UNKNOWN
      const target = this.def.jobs[jobId]
      if (!target) return UNKNOWN
      let t = this.jobOutputType(target, name, depth + 1)
      for (const seg of rest) t = descend(t, seg)
      return t
    }
    return UNKNOWN
  }
}
