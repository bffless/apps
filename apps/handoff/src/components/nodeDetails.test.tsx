/**
 * NodeDetails: the viewer's details block (Task 6) — Title (falling back to
 * filename) + Description in the read view, and the writer-only Edit/Add
 * affordance. The dialog's actual PATCH /api/node/meta wiring is exercised at
 * the store level in ../store/updateNodeMeta.test.ts (Task 5); this file only
 * covers the presentational read/write-gate behavior.
 *
 * Same store-construction pattern as ../components/generalAccess.test.tsx —
 * no MSW here since none of these cases mount the dialog (no network calls).
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { handoffApi } from '../store/handoffApi'
import { NodeDetails } from './NodeDetails'
import type { HandoffNode } from '../lib/nodes'

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
  it('shows the title as heading and the description when set', () => {
    renderWith(<NodeDetails node={node({ title: 'Board Deck', description: 'the note' })} canEdit={false} />)
    expect(screen.getByRole('heading', { name: 'Board Deck' })).toBeInTheDocument()
    expect(screen.getByText('the note')).toBeInTheDocument()
  })

  it('falls back to filename heading when no title is set (still shows for empty when canEdit)', () => {
    renderWith(<NodeDetails node={node({ title: null, description: null })} canEdit={true} />)
    expect(screen.getByRole('button', { name: /add title/i })).toBeInTheDocument()
  })

  it('a non-editor with no metadata renders nothing', () => {
    const { container } = renderWith(<NodeDetails node={node({ title: null, description: null })} canEdit={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('an editor sees an Edit control when metadata is set', () => {
    renderWith(<NodeDetails node={node({ title: 'T' })} canEdit={true} />)
    expect(screen.getByRole('button', { name: /edit details/i })).toBeInTheDocument()
  })
})
