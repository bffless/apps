import type { Expr } from '../expressions/ast.js'

export interface Ref {
  /** The context root, e.g. `steps` in `steps.say.outputs.line`. */
  root: string
  /** Property path after the root; `null` marks a dynamic `[expr]` segment. */
  path: (string | null)[]
  node: Expr
}

export interface CallSite {
  callee: string
  node: Extract<Expr, { kind: 'call' }>
}

/** Every context-root reference and call in an expression, in source order. */
export function collectRefs(expr: Expr): { refs: Ref[]; calls: CallSite[] } {
  const refs: Ref[] = []
  const calls: CallSite[] = []

  function chain(e: Expr): { root: string; path: (string | null)[] } | undefined {
    if (e.kind === 'ident') return { root: e.name, path: [] }
    if (e.kind === 'member') {
      const c = chain(e.object)
      if (!c) return undefined
      return { root: c.root, path: [...c.path, e.property] }
    }
    if (e.kind === 'index') {
      const c = chain(e.object)
      if (!c) return undefined
      const idx = e.index
      const seg =
        idx.kind === 'string' ? idx.value : idx.kind === 'number' ? String(idx.value) : null
      return { root: c.root, path: [...c.path, seg] }
    }
    return undefined
  }

  function walk(e: Expr): void {
    switch (e.kind) {
      case 'ident':
      case 'member':
      case 'index': {
        const c = chain(e)
        if (c) refs.push({ ...c, node: e })
        // dynamic index expressions carry their own refs
        let cur: Expr = e
        while (cur.kind === 'member' || cur.kind === 'index') {
          if (cur.kind === 'index' && cur.index.kind !== 'string' && cur.index.kind !== 'number') {
            walk(cur.index)
          }
          cur = cur.object
        }
        break
      }
      case 'call':
        calls.push({ callee: e.callee, node: e })
        e.args.forEach(walk)
        break
      case 'not':
        walk(e.operand)
        break
      case 'binary':
        walk(e.left)
        walk(e.right)
        break
      default:
        break
    }
  }

  walk(expr)
  return { refs, calls }
}
