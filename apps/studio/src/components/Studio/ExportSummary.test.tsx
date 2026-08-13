import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { Scene } from '../../lib/scenes'
import type { TWord } from '../../lib/transcriptGrid'
import { ExportSummary } from './ExportSummary'

type Props = ComponentProps<typeof ExportSummary>

function scene(over: Partial<Scene> = {}): Scene {
  return {
    id: 's1',
    index: 0,
    sourceId: 'source-1',
    title: 'Scene 1',
    start: 0,
    end: 60,
    transcript: 'original transcript words',
    status: 'built',
    ...over,
  }
}

/** Timed words spaced 1s apart, one per token. */
const timed = (text: string, start = 0): TWord[] =>
  text.split(/\s+/).map((t, i) => ({ text: t, start: start + i, end: start + i + 0.5 }))

const wordsFor = () => timed('Hello world')

function props(overrides: Partial<Props> = {}): Props {
  return {
    scenes: [scene()],
    wordsFor,
    synopsis: 'A tight take',
    description: { title: 'My Video', summary: 'A summary.', script: 'Hello world' },
    generating: false,
    onGenerate: vi.fn(),
    onTitleChange: vi.fn(),
    ...overrides,
  }
}

/**
 * The headless runner (headless/, story 14) drives the Export step by these
 * test-ids — they are a contract, not decoration (see CLAUDE.md).
 */
describe('ExportSummary headless contract', () => {
  it('exposes the card with data-state "done" plus the title/description fields', () => {
    render(<ExportSummary {...props()} />)
    const card = screen.getByTestId('export-summary')
    expect(card).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('export-title')).toHaveValue('My Video')
    expect((screen.getByTestId('export-description') as HTMLTextAreaElement).value).toContain(
      'A summary.',
    )
  })

  it('reports "generating" while the describe call is in flight', () => {
    render(<ExportSummary {...props({ generating: true, description: null })} />)
    expect(screen.getByTestId('export-summary')).toHaveAttribute('data-state', 'generating')
  })

  it('reports "idle" before any description exists', () => {
    // Auto-generate fires on arrival, but until the parent flips `generating`
    // the card is honestly idle — the runner polls for the eventual "done".
    render(<ExportSummary {...props({ description: null })} />)
    expect(screen.getByTestId('export-summary')).toHaveAttribute('data-state', 'idle')
  })
})
