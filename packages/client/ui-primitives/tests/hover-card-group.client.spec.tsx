// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoverCard } from '../src/HoverCard.tsx'
import { HoverCardGroup } from '../src/HoverCardGroup.tsx'
import { Tooltip } from '../src/Tooltip.tsx'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

// jsdom lacks PointerEvent; MouseEvent preserves relatedTarget for physical and React ancestry checks.
function move(from: Element, to: Element): void {
  fireEvent(from, new MouseEvent('pointerout', { bubbles: true, relatedTarget: to }))
  fireEvent(to, new MouseEvent('pointerover', { bubbles: true, relatedTarget: from }))
  fireEvent(from, new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }))
  fireEvent(to, new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }))
}
function tick(ms: number): void { act(() => { vi.advanceTimersByTime(ms) }) }
function Card({ name, grouped = true, disabled = false }: { name: string; grouped?: boolean; disabled?: boolean }) {
  return <HoverCard grouped={grouped} dismissOnTooltip disabled={disabled} openDelayMs={800}
    anchor={<span>{name}<Tooltip label={`Archive ${name}`} delayMs={500}><button type="button">action {name}</button></Tooltip></span>}
    content={<span>details {name}</span>} copyText={name} copyLabel="Copy" copiedLabel="Copied" />
}

describe('HoverCardGroup', () => {
  it('waits for the first actual display, then switches instantly within one physical list', () => {
    render(<HoverCardGroup><Card name="A" /><span>gap</span><Card name="B" /></HoverCardGroup>)
    const a = screen.getByText('A')
    const b = screen.getByText('B')
    const gap = screen.getByText('gap')
    move(document.body, a)
    tick(799)
    expect(screen.queryByText('details A')).toBeNull()
    tick(1)
    expect(screen.getByText('details A')).toBeTruthy()
    move(a, b)
    expect(screen.queryByText('details A')).toBeNull()
    expect(screen.getByText('details B')).toBeTruthy()
    // Repositioning the old anchor must not let it claim ownership again.
    fireEvent(window, new Event('resize'))
    tick(300)
    expect(screen.queryByText('details A')).toBeNull()
    expect(screen.getByText('details B')).toBeTruthy()
    move(b, gap)
    tick(300)
    move(gap, a)
    expect(screen.getByText('details A')).toBeTruthy()
    move(a, document.body)
    tick(300)
    move(document.body, b)
    expect(screen.queryByText('details B')).toBeNull()
    tick(799)
    expect(screen.queryByText('details B')).toBeNull()
    tick(1)
    expect(screen.getByText('details B')).toBeTruthy()
  })

  it('does not warm a list from a cancelled opening or an active tooltip', () => {
    render(<HoverCardGroup><Card name="A" /><Card name="B" /></HoverCardGroup>)
    const a = screen.getByText('A')
    const b = screen.getByText('B')
    move(document.body, a)
    tick(400)
    move(a, b)
    tick(799)
    expect(screen.queryByText('details A')).toBeNull()
    expect(screen.queryByText('details B')).toBeNull()
    const action = screen.getByRole('button', { name: 'action B' })
    move(b, action)
    // The card may open before the tooltip reaches its independent 500ms dwell.
    tick(1)
    expect(screen.getByText('details B')).toBeTruthy()
    move(action, document.body)
    tick(300)
    move(document.body, action)
    tick(500)
    expect(screen.getByRole('tooltip').textContent).toBe('Archive B')
    tick(500)
    expect(screen.queryByText('details B')).toBeNull()
    move(action, a)
    expect(screen.queryByText('details A')).toBeNull()
    tick(800)
    expect(screen.getByText('details A')).toBeTruthy()
  })

  it('resets warmth on physical portal exit without closing readable, copyable content', async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      render(<HoverCardGroup><Card name="A" /><Card name="B" /></HoverCardGroup>)
      const a = screen.getByText('A')
      const b = screen.getByText('B')
      move(document.body, a)
      tick(800)
      const portal = screen.getByRole('button', { name: 'Copy: A' })
      move(a, portal)
      tick(500)
      expect(portal.isConnected).toBe(true)
      await act(async () => { fireEvent.click(portal); await Promise.resolve() })
      expect(writeText).toHaveBeenCalledWith('A')
      expect(screen.getByRole('status').textContent).toBe('Copied')
      move(portal, b)
      expect(screen.queryByText('details B')).toBeNull()
      tick(799)
      expect(screen.queryByText('details B')).toBeNull()
      tick(1)
      expect(screen.getByText('details B')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Copy: A' })).toBeNull()
    } finally {
      if (previous === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', previous)
    }
  })

  it('rejects stale clipboard feedback after a group handoff and return', async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    let finishWrite: (() => void) | undefined
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve }))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      render(<HoverCardGroup><Card name="A" /><Card name="B" /></HoverCardGroup>)
      const a = screen.getByText('A')
      const b = screen.getByText('B')
      move(document.body, a)
      tick(800)
      fireEvent.keyDown(screen.getByRole('button', { name: 'Copy: A' }), { key: 'Enter' })
      expect(writeText).toHaveBeenCalledWith('A')
      move(a, b)
      expect(screen.getByText('details B')).toBeTruthy()
      move(b, a)
      expect(screen.getByText('details A')).toBeTruthy()
      await act(async () => { finishWrite?.(); await Promise.resolve() })
      expect(screen.queryByText('Copied')).toBeNull()
      expect(screen.getByText('details A')).toBeTruthy()
    } finally {
      finishWrite?.()
      if (previous === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', previous)
    }
  })

  it('keeps separate groups cold and does not enroll ungrouped cards', () => {
    render(<><HoverCardGroup><Card name="A" /><Card name="Project" grouped={false} /></HoverCardGroup>
      <HoverCardGroup><Card name="B" /></HoverCardGroup></>)
    const a = screen.getByText('A')
    const project = screen.getByText('Project')
    const b = screen.getByText('B')
    move(document.body, a)
    tick(800)
    move(a, project)
    expect(screen.queryByText('details Project')).toBeNull()
    tick(800)
    expect(screen.getByText('details Project')).toBeTruthy()
    move(project, b)
    expect(screen.queryByText('details B')).toBeNull()
    tick(800)
    expect(screen.getByText('details B')).toBeTruthy()
  })

  it('releases an unmounted active card without cooling its still-mounted list', () => {
    const markup = (showA: boolean, groupKey = 'first') => <HoverCardGroup key={groupKey}>
      {showA && <Card name="A" />}<Card name="B" />
    </HoverCardGroup>
    const view = render(markup(true))
    const a = screen.getByText('A')
    move(document.body, a)
    tick(800)
    view.rerender(markup(false))
    move(a, screen.getByText('B'))
    expect(screen.getByText('details B')).toBeTruthy()
    view.rerender(markup(false, 'new'))
    move(document.body, screen.getByText('B'))
    expect(screen.queryByText('details B')).toBeNull()
    tick(800)
    expect(screen.getByText('details B')).toBeTruthy()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
