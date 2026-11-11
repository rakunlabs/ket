// The window's link to the server, open on every page. Agents open and
// close project tabs through it (open_project, close_project over MCP).

import { base } from './api'
import { tabs } from './tabs.svelte'

type Frame =
  | { t: 'hello'; client: string; build?: string }
  | { t: 'open'; project: string; name?: string; activate?: boolean }
  | { t: 'close'; project: string }
  | { t: 'reload' }
  | { t: 'pong' }

class AppLink {
  connected = $state(false)
  private ws: WebSocket | undefined
  private ping: ReturnType<typeof setInterval> | undefined
  private started = false
  /** The UI build this page loaded, learnt from the first hello. */
  private build: string | undefined

  start() {
    if (this.started) return
    this.started = true
    window.addEventListener('focus', () => this.send({ t: 'focus' }))
    this.connect()
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}${base}/api/v1/app/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      clearInterval(this.ping)
      this.ping = setInterval(() => this.send({ t: 'ping' }), 25_000)
      if (document.hasFocus()) this.send({ t: 'focus' })
    }
    ws.onmessage = (ev) => this.onFrame(JSON.parse(ev.data as string) as Frame)
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.connected = false
      this.ws = undefined
      clearInterval(this.ping)
      setTimeout(() => this.connect(), 2000)
    }
  }

  private send(f: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f))
  }

  private onFrame(f: Frame) {
    switch (f.t) {
      case 'hello':
        // A server restarted with a new UI: load it, so every tab runs the
        // commands the server offers.
        if (f.build && this.build && f.build !== this.build) location.reload()
        this.build ??= f.build
        break
      case 'reload':
        location.reload()
        break
      case 'open':
        tabs.open(f.project, f.name, f.activate !== false)
        break
      case 'close':
        tabs.close(f.project)
        break
    }
  }
}

export const appLink = new AppLink()
