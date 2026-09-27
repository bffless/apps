/**
 * `replyDescribe` — the `reply` step of the `workflow.describe` rule, and of
 * that rule alone (apps#721). It is `reply`'s handler with `workflow.describe`
 * plugged in: the one tool that parses the workflow file's YAML, so the one
 * bundle that carries the `yaml` package. Every other tool rule's `reply`
 * step runs `reply.fn.js`, which has no parser and refuses describe
 * (`DESCRIBE_ELSEWHERE`) should a rule ever be wired to it by mistake.
 *
 * The answer is exactly what `reply` gave before the split: same refusals,
 * same order, same `describeWorkflow` shape (spec 10, D20).
 */
import { textResult, type CallToolResult } from '@bffless/workflow-agent-tools'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { parse } from 'yaml'
import { describeText, describeWorkflow } from '../lib/describe'
import { REFUSALS } from './refusals'
import { handler as reply, refuse, str, type Reply, type StepOutputs } from './reply'
import type { FnDeployment, FnRequest, Route } from './route'

export function describe(route: Route, steps: StepOutputs): CallToolResult {
  if (route.impl === '') return refuse('impl', '`impl` is required')
  if (route.workflow === '') return refuse('workflow', '`workflow` is required')
  if (!route.isDescribe) return refuse('discovery', REFUSALS.discovery)
  if (steps.index?.ok !== true) return refuse('workflow', REFUSALS.noWorkflow)
  const plan = steps.plan
  if (!plan?.hasYaml || !plan.listing) return refuse('workflow', REFUSALS.noWorkflow)
  const yaml = steps.yaml
  if (yaml?.ok !== true || typeof yaml.body !== 'string') return refuse('workflow', REFUSALS.fileUnreadable)
  const entry = plan.listing
  const listing = {
    file: entry.file as string,
    name: str(entry.name) ?? route.workflow,
    ...(str(entry.description) === undefined ? {} : { description: entry.description as string }),
    inputs: typeof entry.inputs === 'number' ? entry.inputs : 0,
    jobs: typeof entry.jobs === 'number' ? entry.jobs : 0,
    headlessSafe: entry.headlessSafe === true,
  }
  let described: ReturnType<typeof describeWorkflow>
  try {
    const def = toDefinition(parse(yaml.body))
    described = describeWorkflow({ impl: route.impl, workflow: route.workflow, listing, def })
  } catch {
    return refuse('workflow', REFUSALS.doesNotLint)
  }
  return textResult(describeText(described), { ...described })
}

export function handler(data: { request?: FnRequest; steps: StepOutputs; deployment?: FnDeployment }): Reply {
  return reply(data, { describe })
}
