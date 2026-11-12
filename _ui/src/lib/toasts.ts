import { writable } from 'svelte/store'

type Tone = 'success' | 'error'
type PauseReason = 'pointer' | 'focus' | 'hidden'

export interface Toast {
  id: number
  message: string
  tone: Tone
}

interface Timer {
  remaining: number
  started: number
  handle?: ReturnType<typeof setTimeout>
  paused: Set<PauseReason>
}

export class ToastStore {
  private state = writable<Toast[]>([])
  private timers = new Map<number, Timer>()
  private nextID = 0
  private hidden = false
  subscribe = this.state.subscribe

  show(message: string, tone: Tone = 'success'): number {
    const id = ++this.nextID
    const timer: Timer = {
      remaining: tone === 'error' || message.length > 100 ? 10_000 : 6_000,
      started: Date.now(),
      paused: new Set(this.hidden ? ['hidden'] : []),
    }
    this.timers.set(id, timer)
    this.state.update((items) => [...items, { id, message, tone }])
    this.start(id, timer)
    return id
  }

  dismiss(id: number) {
    clearTimeout(this.timers.get(id)?.handle)
    this.timers.delete(id)
    this.state.update((items) => items.filter((item) => item.id !== id))
  }

  pause(id: number, reason: PauseReason) {
    const timer = this.timers.get(id)
    if (!timer || timer.paused.has(reason)) return
    if (!timer.paused.size) {
      clearTimeout(timer.handle)
      timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.started))
    }
    timer.paused.add(reason)
  }

  resume(id: number, reason: PauseReason) {
    const timer = this.timers.get(id)
    if (timer?.paused.delete(reason) && !timer.paused.size) this.start(id, timer)
  }

  setHidden(hidden: boolean) {
    this.hidden = hidden
    for (const id of this.timers.keys()) {
      if (hidden) this.pause(id, 'hidden')
      else this.resume(id, 'hidden')
    }
  }

  clear() {
    for (const timer of this.timers.values()) clearTimeout(timer.handle)
    this.timers.clear()
    this.state.set([])
  }

  private start(id: number, timer: Timer) {
    if (timer.paused.size) return
    timer.started = Date.now()
    timer.handle = setTimeout(() => this.dismiss(id), timer.remaining)
  }
}

export const toasts = new ToastStore()
