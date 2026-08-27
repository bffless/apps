import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'
import { expectedRuleFile, findRule, resolveUrl, type RuleSetContext } from '../rules/match.js'

interface Spot {
  pointer: string
  path: string
  method: string
}

/** Every relative endpoint a pipeline step names: the call, then its poll (03). */
function spotsOf(def: Definition): Spot[] {
  const spots: Spot[] = []
  for (const job of Object.values(def.jobs)) {
    for (const step of job.steps) {
      if (step.uses !== 'pipeline') continue
      const base = `/jobs/${job.id}/steps/${step.index}`
      const path = step.raw.with?.path
      if (typeof path === 'string') {
        spots.push({ pointer: `${base}/with/path`, path, method: step.raw.with?.method ?? 'POST' })
      }
      if (step.raw.poll) {
        const pollPath = step.raw.poll.path ?? path
        if (typeof pollPath === 'string') {
          spots.push({
            pointer: `${base}/poll/path`,
            path: pollPath,
            method: step.raw.poll.method ?? 'GET',
          })
        }
      }
    }
  }
  // An absolute path points at another set (the harness, or another
  // implementation) — unknowable from here, and already the `cross-impl-path`
  // warning's business (01).
  return spots.filter((s) => !s.path.startsWith('/'))
}

/**
 * 06: a relative `with.path` / `poll.path` is served by a directory in the
 * implementation's own rule set. Nothing but this check links the two, so a
 * renamed pipeline, a wrong method or a forgotten `poll` rule is otherwise a
 * 404 at run time.
 *
 * Only runs when the caller could see the repo. The harness lints in the
 * browser with no rule set at all and must keep working, so `rules` undefined
 * is silence, and a rule set the CLI looked for but could not find is a notice.
 */
export function checkRules(def: Definition, rules?: RuleSetContext): Finding[] {
  if (!rules) return []
  const spots = spotsOf(def)
  if (spots.length === 0) return []

  if (!rules.found) {
    return [
      {
        rule: 'rule-missing',
        severity: 'notice',
        message: `no rule set found — skipping the rule check for ${spots.length} relative path(s) (${rules.reason})`,
        path: '',
      },
    ]
  }

  const findings: Finding[] = []
  for (const spot of spots) {
    const url = resolveUrl(rules, spot.path)
    if (findRule(rules, url, spot.method)) continue
    findings.push({
      rule: 'rule-missing',
      severity: 'error',
      message:
        `no rule serves \`${spot.method.toUpperCase()} ${url}\` — the \`${rules.alias}\` rule set has no ` +
        `\`${expectedRuleFile(rules, spot.path, spot.method)}\` (06)`,
      path: spot.pointer,
      hint: `rule set: ${rules.dir}`,
    })
  }
  return findings
}
