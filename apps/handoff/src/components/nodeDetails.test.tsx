/**
 * NodeDetails: the viewer's details block (Task 6) — Title (falling back to
 * filename) + Description in the read view, and the writer-only Edit/Add
 * affordance opening a native <dialog>. The dialog's actual PATCH
 * /api/node/meta wiring is exercised at the store level in
 * ../store/updateNodeMeta.test.ts (Task 5); this file covers the
 * presentational read/write-gate behavior plus the dialog opening prefilled.
 *
 * Same store-construction pattern as ../components/generalAccess.test.tsx —
 * no MSW here since none of these cases trigger a save (no network calls).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { handoffApi } from '../store/handoffApi'
import { NodeDetails } from './NodeDetails'
import type { HandoffNode } from '../lib/nodes'

beforeAll(() => {
  // jsdom doesn't implement <dialog>'s showModal()/close() — mirrors the
  // polyfill in ../pages/shareTargetParentChain.test.tsx (dispatches the
  // 'close' event so close() -> onClose routing is actually exercised).
  if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true
    }
  }
  if (typeof HTMLDialogElement.prototype.close !== 'function') {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false
      this.dispatchEvent(new Event('close'))
    }
  }
})

function makeStore() {
  return configureStore({
    reducer: { [handoffApi.reducerPath]: handoffApi.reducer },
    middleware: (gdm) => gdm().concat(handoffApi.middleware),
  })
}

function node(over: Partial<HandoffNode>): HandoffNode {
  return {
    id: 'id1',
    type: 'file',
    name: 'a.png',
    mime: 'image/png',
    size: 1,
    url: null,
    storageKey: null,
    path: 'a.png',
    parentId: 'p',
    createdAt: 1,
    ownerId: null,
    grants: [],
    mode: 'inheriting',
    title: null,
    description: null,
    ...over,
  }
}

function renderWith(ui: React.ReactElement) {
  return render(<Provider store={makeStore()}>{ui}</Provider>)
}

describe('NodeDetails', () => {
  it('shows the set title as the heading, plus the filename subline and the description', () => {
    renderWith(<NodeDetails node={node({ title: 'Board Deck', description: 'x' })} canEdit={false} />)
    expect(screen.getByRole('heading', { name: 'Board Deck' })).toBeInTheDocument()
    expect(screen.getByText('a.png')).toBeInTheDocument()
    expect(screen.getByText('x')).toBeInTheDocument()
  })

  it('falls back to the filename heading when no title is set, and still shows the description', () => {
    renderWith(<NodeDetails node={node({ title: null, description: 'some note' })} canEdit={false} />)
    expect(screen.getByRole('heading', { name: 'a.png' })).toBeInTheDocument()
    expect(screen.getByText('some note')).toBeInTheDocument()
  })

  it('a non-editor with no metadata renders nothing', () => {
    const { container } = renderWith(<NodeDetails node={node({ title: null, description: null })} canEdit={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('an editor with no metadata sees "+ Add title & description" instead of the heading', () => {
    renderWith(<NodeDetails node={node({ title: null, description: null })} canEdit={true} />)
    expect(screen.getByRole('button', { name: /add title/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('an editor sees an Edit control when metadata is set', () => {
    renderWith(<NodeDetails node={node({ title: 'T' })} canEdit={true} />)
    expect(screen.getByRole('button', { name: /edit details/i })).toBeInTheDocument()
  })

  it('clicking Edit details opens the dialog prefilled from the node', () => {
    renderWith(<NodeDetails node={node({ title: 'Board Deck', description: 'the note' })} canEdit={true} />)

    fireEvent.click(screen.getByRole('button', { name: /edit details/i }))

    const dialog = screen.getByRole('dialog', { name: 'Edit details' })
    expect(dialog).toHaveAttribute('open')
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Board Deck')
    expect(within(dialog).getByLabelText('Description')).toHaveValue('the note')
  })

  it('clicking "+ Add title & description" opens the dialog empty', () => {
    renderWith(<NodeDetails node={node({ title: null, description: null })} canEdit={true} />)

    fireEvent.click(screen.getByRole('button', { name: /add title/i }))

    const dialog = screen.getByRole('dialog', { name: 'Edit details' })
    expect(within(dialog).getByLabelText('Title')).toHaveValue('')
    expect(within(dialog).getByLabelText('Description')).toHaveValue('')
  })

  it('clicking Cancel closes the dialog', () => {
    renderWith(<NodeDetails node={node({ title: 'Board Deck', description: 'the note' })} canEdit={true} />)

    fireEvent.click(screen.getByRole('button', { name: /edit details/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
