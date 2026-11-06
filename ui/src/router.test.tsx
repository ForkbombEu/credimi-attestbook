import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { AppLink, parseRoute, rulebookPath, useRoute } from './router'

function resetPath(path = '/'): void {
  window.history.replaceState({}, '', path)
}

afterEach(() => resetPath())

describe('parseRoute', () => {
  test('maps the root and trailing slashes to the catalog', () => {
    expect(parseRoute('/')).toEqual({ name: 'catalog' })
    expect(parseRoute('/rulebooks/')).toEqual({ name: 'catalog' })
    expect(parseRoute('/missing')).toEqual({ name: 'catalog' })
    expect(parseRoute('')).toEqual({ name: 'catalog' })
  })

  test('decodes a rulebook id from a detail path', () => {
    expect(parseRoute('/rulebooks/rulebook-pid')).toEqual({
      name: 'rulebook',
      rulebookId: 'rulebook-pid',
    })
    expect(parseRoute('/rulebooks/rulebook%2Fwith%20space/')).toEqual({
      name: 'rulebook',
      rulebookId: 'rulebook/with space',
    })
  })

  test('falls back to the catalog for malformed paths', () => {
    expect(parseRoute('/rulebooks/%E0%A4%A')).toEqual({ name: 'catalog' })
  })

  test('builds encoded detail paths', () => {
    expect(rulebookPath('rulebook-pid')).toBe('/rulebooks/rulebook-pid')
    expect(rulebookPath('rulebook/with space')).toBe('/rulebooks/rulebook%2Fwith%20space')
  })
})

describe('useRoute', () => {
  test('navigates in place and follows browser back/forward', () => {
    resetPath('/')
    const { result } = renderHook(() => useRoute())

    expect(result.current.route).toEqual({ name: 'catalog' })

    act(() => result.current.navigate('/rulebooks/rulebook-pid'))
    expect(window.location.pathname).toBe('/rulebooks/rulebook-pid')
    expect(result.current.route).toEqual({ name: 'rulebook', rulebookId: 'rulebook-pid' })

    act(() => {
      window.history.replaceState({}, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(result.current.route).toEqual({ name: 'catalog' })
  })

  test('ignores navigation to the current path', () => {
    resetPath('/')
    const { result } = renderHook(() => useRoute())

    act(() => result.current.navigate('/'))

    expect(window.location.pathname).toBe('/')
    expect(result.current.route).toEqual({ name: 'catalog' })
  })
})

describe('AppLink', () => {
  test('navigates on an unmodified click and keeps a native href', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    render(
      <AppLink href="/rulebooks/rulebook-pid" onNavigate={onNavigate}>
        PID Rulebook
      </AppLink>,
    )

    const link = screen.getByRole('link', { name: 'PID Rulebook' })
    expect(link).toHaveAttribute('href', '/rulebooks/rulebook-pid')

    await user.click(link)

    expect(onNavigate).toHaveBeenCalledWith('/rulebooks/rulebook-pid')
  })

  test('leaves modified clicks to the browser', async () => {
    const onNavigate = vi.fn()
    render(
      <AppLink href="/rulebooks/rulebook-pid" onNavigate={onNavigate}>
        PID Rulebook
      </AppLink>,
    )

    const link = screen.getByRole('link', { name: 'PID Rulebook' })
    link.addEventListener('click', (event) => event.preventDefault(), { once: true })
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))

    expect(onNavigate).not.toHaveBeenCalled()
  })
})
