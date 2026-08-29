import { describe, expect, it } from 'vitest'
import helloYaml from '../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from './runner/definition'
import { RUN_SCOPE, resolveOutput, resolveOutputDecl, stepOutputDecl } from './outputDecls'
import { FRAMES_DEF } from '../test/framesRun'
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

  // apps#446: a markdown output's `images` map rides along as declared, and
  // only on markdown — any other type drops it (the linter has already said so).
  it("carries a markdown output's `images` map as declared, and only on markdown", () => {
    const say = step('greet', 'say')
    const raw = {
      post: { type: 'markdown', images: '${{ steps.frames.outputs.srcs }}' },
      literal: { type: 'markdown', images: { 'frame:1': 'workflows/x.jpg' } },
      note: { type: 'string', images: '${{ steps.frames.outputs.srcs }}' },
    }
    const withImages = { ...say, raw: { ...say.raw, outputs: raw } } as typeof say
    expect(stepOutputDecl(withImages, 'post')).toEqual({ type: 'markdown', images: '${{ steps.frames.outputs.srcs }}' })
    expect(stepOutputDecl(withImages, 'literal')).toEqual({ type: 'markdown', images: { 'frame:1': 'workflows/x.jpg' } })
    expect(stepOutputDecl(withImages, 'note')).toEqual({ type: 'string' })
  })

  it('is json for the bare `response` of a pipeline step with no outputs map', () => {
    expect(stepOutputDecl(step('flaky', 'boom'), 'response')).toEqual({ type: 'json' })
  })
})

describe('resolveOutput', () => {
  it('reports the site a bare output followed to — the step, with its matrix-ness', () => {
    expect(resolveOutput(hello, RUN_SCOPE, 'lines').site).toEqual({ kind: 'step', job: 'greet', step: 'say', matrix: true })
    expect(resolveOutput(hello, RUN_SCOPE, 'report').site).toEqual({ kind: 'step', job: 'confirm', step: 'review', matrix: false })
    expect(resolveOutput(FRAMES_DEF, RUN_SCOPE, 'post')).toEqual({
      decl: { type: 'markdown', images: '${{ steps.bundle.outputs.srcs }}' },
      site: { kind: 'step', job: 'blog', step: 'bundle', matrix: false },
    })
  })

  it('reports the declaring scope for a typed job/run output, and no site when unresolved', () => {
    const typedJob = {
      ...FRAMES_DEF,
      jobs: {
        ...FRAMES_DEF.jobs,
        blog: { ...FRAMES_DEF.jobs.blog!, outputs: { post: { type: 'markdown', value: 'x', images: {} } } },
      },
    } as Definition
    expect(resolveOutput(typedJob, { kind: 'job', job: 'blog' }, 'post').site).toEqual({ kind: 'job', job: 'blog' })
    expect(resolveOutput(hello, RUN_SCOPE, 'nope')).toEqual({ decl: { type: 'json' }, site: null })
  })
})
