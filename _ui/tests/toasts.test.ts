import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastStore } from '../src/lib/toasts'

describe('toast notifications', () => {
  let toasts: ToastStore

  beforeEach(() => {
    vi.useFakeTimers()
    toasts = new ToastStore()
  })

  afterEach(() => {
    toasts.clear()
    vi.useRealTimers()
  })

  it('dismisses short success messages after six seconds', () => {
    const id = toasts.show('Project file downloaded.')
    expect(get(toasts)).toEqual([{ id, message: 'Project file downloaded.', tone: 'success' }])
    vi.advanceTimersByTime(5999)
    expect(get(toasts)).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(get(toasts)).toEqual([])
  })

  it('gives errors and long messages ten seconds to be read', () => {
    toasts.show('Export failed.', 'error')
    toasts.show('Prototype package downloaded. Review its ORDERING.md and manufacturing.json before ordering. Remote assets may need network access.')
    vi.advanceTimersByTime(6000)
    expect(get(toasts)).toHaveLength(2)
    vi.advanceTimersByTime(4000)
    expect(get(toasts)).toEqual([])
  })

  it('keeps independent timers and cancels dismissed notifications', () => {
    const first = toasts.show('First download.')
    vi.advanceTimersByTime(3000)
    const second = toasts.show('Second download.')
    toasts.dismiss(first)
    vi.advanceTimersByTime(3000)
    expect(get(toasts).map((toast) => toast.id)).toEqual([second])
    vi.advanceTimersByTime(3000)
    expect(get(toasts)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pauses while hovered or focused, then resumes the remaining time', () => {
    const id = toasts.show('Project file downloaded.')
    vi.advanceTimersByTime(2000)
    toasts.pause(id, 'pointer')
    toasts.pause(id, 'pointer')
    toasts.pause(id, 'focus')
    vi.advanceTimersByTime(20_000)
    toasts.resume(id, 'pointer')
    vi.advanceTimersByTime(20_000)
    expect(get(toasts)).toHaveLength(1)
    toasts.resume(id, 'focus')
    vi.advanceTimersByTime(3999)
    expect(get(toasts)).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(get(toasts)).toEqual([])
  })

  it('pauses existing and new notifications while the page is hidden', () => {
    toasts.show('First download.')
    vi.advanceTimersByTime(2000)
    toasts.setHidden(true)
    toasts.show('Second download.')
    vi.advanceTimersByTime(20_000)
    expect(get(toasts)).toHaveLength(2)
    toasts.setHidden(false)
    vi.advanceTimersByTime(4000)
    expect(get(toasts)).toHaveLength(1)
    vi.advanceTimersByTime(2000)
    expect(get(toasts)).toEqual([])
  })

  it('clears all pending timers', () => {
    toasts.show('First download.')
    toasts.show('Second download.')
    toasts.clear()
    expect(get(toasts)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
