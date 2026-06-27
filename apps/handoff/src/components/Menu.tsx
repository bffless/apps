/**
 * Menu — a reusable dropdown built on a portal + fixed positioning so it never
 * clips inside scrolling/overflow-hidden containers (the listing table, the
 * sticky header). Used by the header account menu, the "New ▾" menu, and the
 * per-row kebab.
 *
 * Keyboard: Enter/Space/ArrowDown opens and focuses the first item; ArrowUp/Down
 * move; Enter/Space activate; Escape or Tab close and restore focus to the
 * trigger. Outside-click and scroll/resize close it.
 */

import {
  useId,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export type MenuItem =
  | 'separator'
  | { heading: ReactNode }
  | {
      label: string
      onSelect: () => void
      icon?: ReactNode
      danger?: boolean
      disabled?: boolean
      /** Optional helper line under the label. */
      hint?: string
    }

/** The actionable (clickable) menu item shape. */
export type MenuActionItem = Extract<MenuItem, { label: string }>

interface TriggerArgs {
  ref: (el: HTMLElement | null) => void
  onClick: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  id: string
}

export interface MenuProps {
  trigger: (args: TriggerArgs) => ReactNode
  items: MenuItem[]
  /** Horizontal edge of the menu aligned to the trigger. Default 'end'. */
  align?: 'start' | 'end'
  /** Accessible name for the menu list. */
  label?: string
}

export function Menu({ trigger, items, align = 'end', label }: MenuProps) {
  const triggerId = useId()
  const menuId = useId()
  const triggerRef = useRef<HTMLElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const setTriggerRef = useCallback((el: HTMLElement | null) => {
    triggerRef.current = el
  }, [])
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  const [activeIndex, setActiveIndex] = useState<number>(-1)

  const isAction = (it: MenuItem): it is MenuActionItem =>
    it !== 'separator' && !('heading' in it)
  const itemIndexes = items.map((it, i) => (isAction(it) ? i : -1)).filter((i) => i >= 0)

  const position = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const minWidth = Math.max(r.width, 180)
    const left = align === 'end' ? r.right - minWidth : r.left
    setCoords({ top: r.bottom + 6, left: Math.max(8, left), minWidth })
  }, [align])

  useLayoutEffect(() => {
    if (open) position()
  }, [open, position])

  useEffect(() => {
    if (!open) return
    function onScroll() {
      setOpen(false)
    }
    function onResize() {
      position()
    }
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    document.addEventListener('mousedown', onDocMouseDown)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('mousedown', onDocMouseDown)
    }
  }, [open, position])

  // Focus management: focus the active item; restore to trigger on close.
  useEffect(() => {
    if (open && activeIndex >= 0) {
      const node = menuRef.current?.querySelector<HTMLButtonElement>(
        `[data-index="${activeIndex}"]`,
      )
      node?.focus()
    }
  }, [open, activeIndex])

  function openMenu(focusFirst: boolean) {
    setActiveIndex(focusFirst ? (itemIndexes[0] ?? -1) : -1)
    setOpen(true)
  }

  function closeMenu(restoreFocus = true) {
    setOpen(false)
    setActiveIndex(-1)
    if (restoreFocus) triggerRef.current?.focus()
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openMenu(true)
    }
  }

  function move(delta: number) {
    const positions = itemIndexes
    if (positions.length === 0) return
    const cur = positions.indexOf(activeIndex)
    const next = cur === -1 ? 0 : (cur + delta + positions.length) % positions.length
    setActiveIndex(positions[next])
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Tab') {
      closeMenu(false)
    }
  }

  function activate(item: MenuActionItem) {
    if (item.disabled) return
    closeMenu()
    item.onSelect()
  }

  return (
    <>
      {/* The render-prop hands the trigger a ref *callback* (setTriggerRef), which
          React invokes at commit, not during render. The compiler lint can't see
          that through the function boundary, so silence its false positive here. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      {trigger({
        ref: setTriggerRef,
        onClick: () => (open ? closeMenu() : openMenu(false)),
        onKeyDown: onTriggerKeyDown,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        id: triggerId,
      })}
      {open &&
        coords &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            aria-labelledby={label ? undefined : triggerId}
            onKeyDown={onMenuKeyDown}
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              minWidth: coords.minWidth,
              zIndex: 'var(--z-dropdown)',
            }}
            className="menu-pop overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-md"
          >
            {items.map((item, i) =>
              item === 'separator' ? (
                <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-border" />
              ) : 'heading' in item ? (
                <div key={`head-${i}`} className="truncate px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted">
                  {item.heading}
                </div>
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  data-index={i}
                  disabled={item.disabled}
                  tabIndex={-1}
                  onClick={() => activate(item)}
                  className={[
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                    item.danger
                      ? 'text-danger hover:bg-danger-bg focus:bg-danger-bg'
                      : 'text-ink hover:bg-accent-bg focus:bg-accent-bg',
                  ].join(' ')}
                >
                  {item.icon && (
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center ${item.danger ? 'text-danger' : 'text-muted'}`}>
                      {item.icon}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                    {item.hint && <span className="block truncate text-xs text-muted">{item.hint}</span>}
                  </span>
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
