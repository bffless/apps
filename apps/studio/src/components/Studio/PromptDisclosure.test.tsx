import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PromptDisclosure } from './PromptDisclosure'

/** jsdom doesn't toggle <details> on summary click reliably — set .open and
 *  fire the toggle event the component listens for. */
function expand() {
  const details = screen.getByText(/view the prompt/i).closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
}

describe('PromptDisclosure (story 03m)', () => {
  it('is collapsed by default and calls onOpen only on first expand', () => {
    const onOpen = vi.fn()
    render(<PromptDisclosure label="View the prompt sent to the AI" onOpen={onOpen} />)
    expect(onOpen).not.toHaveBeenCalled()
    expand()
    expand()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('renders prompt and system as collapsed sub-sections', () => {
    render(
      <PromptDisclosure
        label="View the prompt sent to the AI"
        onOpen={() => {}}
        prompt="THE PROMPT TEXT"
        system="THE SYSTEM TEXT"
      />,
    )
    expand()
    expect(screen.getByText('Prompt')).toBeInTheDocument()
    expect(screen.getByText('System instruction')).toBeInTheDocument()
    expect(screen.getByText('THE PROMPT TEXT')).toBeInTheDocument()
    expect(screen.getByText('THE SYSTEM TEXT')).toBeInTheDocument()
  })

  it('shows the not-available fallback for old runs', () => {
    render(
      <PromptDisclosure label="View the prompt sent to the AI" onOpen={() => {}} loaded />,
    )
    expand()
    expect(screen.getByText(/not available for this run/i)).toBeInTheDocument()
  })

  it('shows a muted error line on fetch failure', () => {
    render(
      <PromptDisclosure label="View the prompt sent to the AI" onOpen={() => {}} error />,
    )
    expand()
    expect(screen.getByText(/couldn't load/i)).toBeInTheDocument()
  })
})
