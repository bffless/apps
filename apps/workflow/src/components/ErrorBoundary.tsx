/**
 * The harness's floor. Every screen below `Shell`'s `<Outlet/>` renders values
 * a *run* produced — arbitrary JSON a step wrote — so a shape nobody predicted
 * (a null table row, a number where an object was assumed) can throw during
 * render. React's answer to an uncaught render error is to unmount the entire
 * tree: one bad cell would otherwise blank the whole app, header and rail
 * included, with no route left to click back to.
 *
 * A class component because `getDerivedStateFromError` has no hook equivalent —
 * this is the one thing hooks still cannot do. Defining it is all React needs
 * to treat this as a boundary; `componentDidCatch` is deliberately absent,
 * because React already logs the error and its component stack itself and a
 * second log would only double the noise.
 *
 * `Shell` keys this on the pathname, so navigating away is itself a reset: the
 * boundary for the new location is a new instance with no error in it.
 */
import { Component } from 'react'
import type { ReactNode } from 'react'
import { EmptyState } from './EmptyState'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  private reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <EmptyState title="Something went wrong rendering this page">
        <p className="empty-detail">{error.message}</p>
        <button type="button" className="link-button" onClick={this.reset}>
          Try again
        </button>
      </EmptyState>
    )
  }
}
