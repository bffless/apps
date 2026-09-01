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

  // `--path-prefix` is prepended to *both* sides of the comparison below — the
  // derived patterns and every resolved URL — so a wrong value cancels out and
  // lints exactly as clean as the right one. Validate the flag itself instead,
  // against the one shape both publishers apply (`workflow publish` and
  // bffless/publish-workflow both derive it from the alias): `/api/<alias>`.
  // This fires regardless of the file's paths — the flag describes the whole
  // sync, and a set pushed under any other prefix 404s once live (#560).
  const prefixFindings: Finding[] = []
  if (rules.found && rules.pathPrefix !== undefined && rules.pathPrefix !== `/api/${rules.alias}`) {
    prefixFindings.push({
      rule: 'path-prefix-mismatch',
      severity: 'error',
      message:
        `--path-prefix \`${rules.pathPrefix}\` is not the prefix the publisher applies — the ` +
        `\`${rules.alias}\` set deploys under \`/api/${rules.alias}\`, so paths resolved against ` +
        `\`${rules.pathPrefix}\` would 404 once live (06)`,
      path: '',
      hint: `the alias comes from the set's \`name:\` (or --alias); pass --path-prefix /api/${rules.alias}`,
    })
  }

  const spots = spotsOf(def)
  if (spots.length === 0) return prefixFindings

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

  const findings: Finding[] = prefixFindings
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
