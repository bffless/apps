export type Severity = 'error' | 'warning' | 'notice'

export interface Finding {
  rule: string
  severity: Severity
  message: string
  /** JSON pointer into the document; '' means the whole document. */
  path: string
  /** 1-based position in the source, when it could be resolved. */
  pos?: { line: number; col: number }
  hint?: string
}

export interface Counts {
  errors: number
  warnings: number
  notices: number
}

export function countFindings(findings: Finding[]): Counts {
  const counts: Counts = { errors: 0, warnings: 0, notices: 0 }
  for (const f of findings) {
    if (f.severity === 'error') counts.errors++
    else if (f.severity === 'warning') counts.warnings++
    else counts.notices++
  }
  return counts
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, notice: 2 }

/** Stable presentation order: by line, then severity, then rule. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      (a.pos?.line ?? 0) - (b.pos?.line ?? 0) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.rule.localeCompare(b.rule),
  )
}
