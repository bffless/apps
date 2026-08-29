import { describe, expect, it } from 'vitest'
import helloYaml from '../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from './runner/definition'
import { RUN_SCOPE, resolveOutputDecl, stepOutputDecl } from './outputDecls'
import type { Definition } from './runner/types'

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition

const step = (job: string, id: string) => hello.jobs[job]!.steps.find((s) => s.id === id)!

describe('resolveOutputDecl', () => {
  it('follows a bare top-level expression to the step output it names', () => {
    // report → jobs.confirm.outputs.report → steps.review.outputs.report → the
    // form field's `type: markdown`.
    expect(resolveOutputDecl(hello, RUN_SCOPE, 'report')).toEqual({ type: 'markdown' })
    expect(resolveOutputDecl(hello, RUN_SCOPE, 'poster')).toEqual({ type: 'file' })
  })

  it("marks a matrix job's collected output as a list", () => {
    expect(resolveOutputDecl(hello, RUN_SCOPE, 'lines')).toEqual({ type: 'string', list: true })
    expect(resolveOutputDecl(hello, { kind: 'job', job: 'greet' }, 'lines')).toEqual({
      type: 'string',
      list: true,
    })
  })

  it('resolves a job output against its own steps', () => {
    expect(resolveOutputDecl(hello, { kind: 'job', job: 'slow' }, 'report')).toEqual({
      type: 'markdown',
    })
  })

  it('falls back to json when nothing can be resolved', () => {
    expect(resolveOutputDecl(hello, RUN_SCOPE, 'nope')).toEqual({ type: 'json' })
    expect(resolveOutputDecl(hello, { kind: 'job', job: 'nope' }, 'report')).toEqual({
      type: 'json',
    })
  })
})

describe('stepOutputDecl', () => {
  it('reads a declared output map', () => {
    expect(stepOutputDecl(step('greet', 'say'), 'line')).toEqual({ type: 'string' })
    expect(stepOutputDecl(step('slow', 'start'), 'poster')).toEqual({ type: 'file' })
  })

  it("reads a form step's fields, which are its outputs (03)", () => {
    expect(stepOutputDecl(step('confirm', 'review'), 'approved')).toEqual({ type: 'boolean' })
    expect(stepOutputDecl(step('confirm', 'review'), 'report')).toEqual({ type: 'markdown' })
  })

  // apps#440: the viewer reads `format: textarea` to draw a block, so the
  // hint has to survive the trip from the YAML to the `ValueDecl`.
  it('carries a string output\'s `format` through to the renderer', () => {
    const say = step('greet', 'say')
    const withFormat = {
      ...say,
      raw: { ...say.raw, outputs: { note: { type: 'string', format: 'textarea' } } },
    } as typeof say
    expect(stepOutputDecl(withFormat, 'note')).toEqual({ type: 'string', format: 'textarea' })
  })

  it('is json for the bare `response` of a pipeline step with no outputs map', () => {
    expect(stepOutputDecl(step('flaky', 'boom'), 'response')).toEqual({ type: 'json' })
  })
})
