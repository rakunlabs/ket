// Open projects, one tab each. A tab is live (mounted, with its own
// session and kernel worker) once it has been shown or an agent opened it;
// tabs restored after a reload stay labels until clicked. To bound memory
// and WebGL contexts at most MAX_LIVE tabs are live: opening another puts
// the least recently used one to sleep (it stays in the bar).
//
// The list is kept per browser tab (sessionStorage), so a reload keeps it
// and two windows do not fight over it.

import { router } from './router.svelte'

const KEY = 'ket.tabs'
export const MAX_LIVE = 6

export class Tab {
  name = $state('')
  live = $state(false)
  /** An agent is working in the tab right now. */
  agent = $state(false)
  used = 0

  constructor(
    readonly id: string,
    name = '',
  ) {
    this.name = name
  }
}

class Tabs {
  list = $state<Tab[]>(restore())

  /** The tab on screen, if a project is shown. */
  get active(): Tab | undefined {
    if (router.settings) return undefined
    const id = router.project
    return id ? this.list.find((t) => t.id === id) : undefined
  }

  get(id: string) {
    return this.list.find((t) => t.id === id)
  }

  /** Opens a project in a tab (or finds its tab) and makes it live;
   *  activate shows it. */
  open(id: string, name = '', activate = true): Tab {
    let tab = this.get(id)
    if (!tab) {
      tab = new Tab(id, name)
      this.list.push(tab)
      tab = this.get(id)!
    } else if (name) {
      tab.name = name
    }
    this.wake(tab)
    if (activate && router.project !== id) router.go(`/p/${id}`)
    this.save()
    return tab
  }

  /** Makes a tab live, putting the least recently used one to sleep when
   *  too many are. */
  wake(tab: Tab) {
    tab.used = Date.now()
    if (tab.live) return
    tab.live = true
    const others = this.list.filter((t) => t.live && t !== tab)
    if (others.length < MAX_LIVE) return
    // Never the tab on screen; tabs an agent works in only as a last resort.
    const candidates = others.filter((t) => t !== this.active)
    const idle = candidates.filter((t) => !t.agent)
    const victim = (idle.length ? idle : candidates).sort((a, b) => a.used - b.used)[0]
    if (victim) victim.live = false
  }

  close(id: string) {
    const i = this.list.findIndex((t) => t.id === id)
    if (i < 0) return
    const wasActive = this.active?.id === id
    this.list.splice(i, 1)
    this.save()
    if (wasActive) {
      const next = this.list[i] ?? this.list[i - 1]
      router.go(next ? `/p/${next.id}` : '/')
    }
  }

  rename(id: string, name: string) {
    const tab = this.get(id)
    if (tab && tab.name !== name) {
      tab.name = name
      this.save()
    }
  }

  move(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= this.list.length || to >= this.list.length) return
    const [t] = this.list.splice(from, 1)
    this.list.splice(to, 0, t)
    this.save()
  }

  private save() {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(this.list.map((t) => ({ id: t.id, name: t.name }))))
    } catch {
      // Storage blocked: tabs last for this page.
    }
  }
}

function restore(): Tab[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as { id: string; name?: string }[]
    return raw.filter((t) => typeof t.id === 'string').map((t) => new Tab(t.id, t.name))
  } catch {
    return []
  }
}

export const tabs = new Tabs()
