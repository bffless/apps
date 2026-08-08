import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BrowserSupportBanner } from './BrowserSupportBanner'

const FIREFOX_UA =
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function stubUserAgent(ua: string) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BrowserSupportBanner', () => {
  it('shows the warning in non-Firefox browsers', () => {
    stubUserAgent(CHROME_UA)
    render(<BrowserSupportBanner />)
    expect(screen.getByRole('alert')).toHaveTextContent(/firefox/i)
  })

  it('renders nothing in Firefox', () => {
    stubUserAgent(FIREFOX_UA)
    render(<BrowserSupportBanner />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('can be dismissed', () => {
    stubUserAgent(CHROME_UA)
    render(<BrowserSupportBanner />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
