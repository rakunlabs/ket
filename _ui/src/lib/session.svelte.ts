// A Session is one open project in this tab. It owns the document, keeps
// it in sync with the server's op log, and executes commands, both the
// user's and those MCP clients and the agent send through the server.
//
// The document is always the replay of ops 1..head. A local edit is applied
// optimistically, then committed; when the server refuses (someone else
// committed first), the session reloads and re-applies the op on top.

import { type Doc, type Op, applyOp, command, emptyDoc, normalizeDoc, parseArgs } from '../engine'
import type { BuildResult, MeshData, SketchLines } from '../engine/kernel'
import type { BoardRenderOptions, RenderOptions, Services } from '../engine/registry'
import type { BoardState } from '../engine/pcb/state'
import { api, base, type StoredOp, wsURL } from './api'
import { type Built, KernelClient } from './kernel-client'

export interface LogEntry {
  seq: number
  cmd: string
  summary: string
  author: string
  at: string
}

export interface Activity {
  author: string
  text: string
  at: number
}

export type Renderer = (opts: RenderOptions) => Promise<{ images: { mime: string; data: string }[]; views: string[] }>
export type BoardRenderer = (opts: BoardRenderOptions) => Promise<{ images: { mime: string; data: string }[] }>

type Frame =
  | { t: 'hello'; session: string; head: number; top: number }
  | { t: 'ack'; id: string; seq: number }
  | { t: 'nack'; id: string; error: string; head?: number }
  | { t: 'op'; seq: number; op: Op; author: string; message: string }
  | { t: 'head'; head: number; top: number }
  | { t: 'call'; id: string; cmd: string; args: unknown; author: string }
  | { t: 'activity'; author: string; text: string }
  | { t: 'branch'; event: 'proposed' | 'accepted' | 'rejected'; branch: string; name?: string; head?: number }
  | { t: 'pong' }

export class Session {
  doc = $state<Doc>(emptyDoc())
  build = $state<BuildResult | undefined>(undefined)
  meshes = $state.raw<MeshData[]>([])
  sketchLines = $state.raw<SketchLines[]>([])
  board = $state.raw<BoardState | undefined>(undefined)
  boardRenderer: BoardRenderer | undefined
  schematicRenderer: ((size: number) => Promise<{ images: { mime: string; data: string }[] }>) | undefined
  head = $state(0)
  top = $state(0)
  log = $state<LogEntry[]>([])
  connected = $state(false)
  building = $state(false)
  /** The log is replayed and the first build is on screen (or failed). */
  ready = $state(false)
  error = $state<string | undefined>(undefined)
  activity = $state<Activity | undefined>(undefined)
  selected = $state<string | undefined>(undefined)
  /** The session's tab is on screen; hidden tabs ignore the keyboard and
   *  stop drawing, but still run commands. */
  visible = $state(true)

  renderer: Renderer | undefined

  private kernel = new KernelClient()
  private ws: WebSocket | undefined
  private waiters = new Map<string, { resolve: (seq: number) => void; reject: (e: Error) => void }>()
  private frameId = 0
  private closed = false
  /** Ops 1..top as stored, to move the head without refetching. */
  private ops: StoredOp[] = []
  /** Commands run one at a time so ops keep their order. */
  private chain: Promise<unknown> = Promise.resolve()
  private pingTimer: ReturnType<typeof setInterval> | undefined

  /** The branch this session shows; undefined = main. */
  branch = $state<string | undefined>(undefined)
  /** A proposal waiting for review (shown as a banner on main). */
  proposal = $state<{ id: string; name: string } | undefined>(undefined)
  /** Main's document while viewing a proposal, for the diff. */
  mainDoc = $state.raw<Doc | undefined>(undefined)

  constructor(readonly projectID: string) {}

  /** Switch to a branch (or main) and reconnect. */
  async switchBranch(branch: string | undefined) {
    if (branch === this.branch && this.ws) return
    this.branch = branch
    const old = this.ws
    this.ws = undefined
    old?.close()
    clearInterval(this.pingTimer)
    this.connected = false
    await this.reload()
    this.connect()
    if (branch) {
      const main = await api.ops(this.projectID, 0, false)
      let doc = emptyDoc()
      for (const o of main.ops) {
        try {
          doc = applyOp(doc, o.op as Op).doc
        } catch {
          // skipped
        }
      }
      this.mainDoc = doc
    } else {
      this.mainDoc = undefined
    }
  }

  async accept() {
    if (!this.branch) return
    const id = this.branch
    await api.acceptBranch(id)
    this.proposal = undefined
    await this.switchBranch(undefined)
  }

  async reject() {
    const id = this.branch ?? this.proposal?.id
    if (!id) return
    await api.rejectBranch(id)
    this.proposal = undefined
    await this.switchBranch(undefined)
  }

  async open() {
    // Resume a pending proposal (newest first).
    try {
      const branches = await api.branches(this.projectID)
      const p = branches.filter((b) => b.parent_id).at(-1)
      if (p) {
        this.proposal = { id: p.id, name: p.name }
        await this.switchBranch(p.id)
        return
      }
    } catch {
      // older servers
    }
    await this.reload()
    this.connect()
  }

  close() {
    this.closed = true
    clearInterval(this.pingTimer)
    this.ws?.close()
    this.kernel.dispose()
  }

  /** Fetches the whole log and replays it up to head. */
  private async reload() {
    const all = await api.ops(this.projectID, 0, true, this.branch)
    this.ops = all.ops
    this.top = all.top
    this.replayTo(all.head)
  }

  private replayTo(head: number) {
    let doc = emptyDoc()
    const log: LogEntry[] = []
    for (const o of this.ops) {
      if (o.seq > head) break
      try {
        const out = applyOp(doc, o.op as Op)
        doc = out.doc
        log.push({ seq: o.seq, cmd: o.op.cmd, summary: o.message || out.summary, author: o.author, at: o.created_at })
      } catch (e) {
        // An op that no longer applies is skipped, not fatal.
        log.push({ seq: o.seq, cmd: o.op.cmd, summary: `skipped: ${(e as Error).message}`, author: o.author, at: o.created_at })
      }
    }
    this.doc = doc
    this.head = head
    this.log = log
    this.replayed = true
    void this.rebuild()
  }

  private connect() {
    if (this.closed) return
    const ws = new WebSocket(wsURL(this.projectID, this.branch))
    this.ws = ws
    ws.onopen = () => {
      clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => this.sendFrame({ t: 'ping' }), 25_000)
    }
    ws.onmessage = (ev) => {
      if (this.ws === ws) void this.onFrame(JSON.parse(ev.data as string) as Frame)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.connected = false
      clearInterval(this.pingTimer)
      this.ws = undefined
      for (const w of this.waiters.values()) w.reject(new Error('connection lost'))
      this.waiters.clear()
      if (!this.closed)
        setTimeout(() => {
          if (!this.ws) this.connect()
        }, 1500)
    }
  }

  private sendFrame(f: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f))
  }

  private async onFrame(f: Frame) {
    switch (f.t) {
      case 'hello':
        this.connected = true
        if (f.head !== this.head || f.top !== this.top) await this.reload()
        break
      case 'ack':
        this.waiters.get(f.id)?.resolve(f.seq)
        this.waiters.delete(f.id)
        break
      case 'nack':
        this.waiters.get(f.id)?.reject(new Error(f.error))
        this.waiters.delete(f.id)
        break
      case 'op':
        // Another tab or agent committed. Ops arrive in order; on a gap
        // reload.
        if (f.seq !== this.head + 1) {
          await this.reload()
          break
        }
        this.ops = this.ops.filter((o) => o.seq < f.seq)
        this.ops.push({ seq: f.seq, op: f.op as StoredOp['op'], author: f.author, message: f.message, created_at: new Date().toISOString() })
        this.top = f.seq
        this.applyLocal(f.op, f.seq, f.author, f.message)
        break
      case 'head':
        this.top = f.top
        if (f.top > this.ops.length) await this.reload()
        else this.replayTo(f.head)
        break
      case 'call':
        void this.serveCall(f)
        break
      case 'branch':
        if (f.event === 'proposed') {
          this.proposal = { id: f.branch, name: f.name ?? 'proposal' }
          // Follow the agent so the user watches it work.
          await this.switchBranch(f.branch)
        } else if (f.branch === this.branch || f.branch === this.proposal?.id) {
          this.proposal = undefined
          await this.switchBranch(undefined)
        }
        break
      case 'activity':
        this.activity = { author: f.author, text: f.text, at: Date.now() }
        break
    }
  }

  private applyLocal(op: Op, seq: number, author: string, message?: string) {
    try {
      const out = applyOp(this.doc, op)
      this.doc = out.doc
      this.log = [...this.log, { seq, cmd: op.cmd, summary: message || out.summary, author, at: new Date().toISOString() }]
    } catch (e) {
      this.log = [...this.log, { seq, cmd: op.cmd, summary: `skipped: ${(e as Error).message}`, author, at: new Date().toISOString() }]
    }
    this.head = seq
    void this.rebuild()
  }

  private async commit(op: Op, base: number, author: string, message: string): Promise<number> {
    if (!this.connected) throw new Error('not connected to the server')
    const id = `c${++this.frameId}`
    const p = new Promise<number>((resolve, reject) => this.waiters.set(id, { resolve, reject }))
    this.sendFrame({ t: 'commit', id, base, op, author, message })
    return p
  }

  private rebuildSeq = 0
  /** The stored log has been applied: a build from here on shows the real design. */
  private replayed = false

  /** Builds the current doc in the worker and publishes meshes. */
  async rebuild(): Promise<Built | undefined> {
    const seq = ++this.rebuildSeq
    const doc = this.doc
    this.building = true
    try {
      const b = await this.kernel.build(doc)
      if (seq === this.rebuildSeq) {
        this.build = b.build
        this.meshes = b.meshes
        this.sketchLines = b.sketches
        this.board = b.board
        this.error = undefined
      }
      return b
    } catch (e) {
      if (seq === this.rebuildSeq) this.error = (e as Error).message
      return undefined
    } finally {
      if (seq === this.rebuildSeq) {
        this.building = false
        if (this.replayed) this.ready = true
      }
    }
  }

  /**
   * Runs a command. Mutations are applied, committed and built; the result
   * tells what changed and how the build went, so a model can go on
   * without another call. Queries return their answer.
   */
  run(cmd: string, args: unknown, author = 'user'): Promise<unknown> {
    const p = this.chain.then(() => this.exec(cmd, args, author))
    this.chain = p.catch(() => undefined)
    return p
  }

  private async exec(cmd: string, args: unknown, author: string): Promise<unknown> {
    const def = command(cmd)
    if (!def) throw new Error(`unknown command "${cmd}" in this Ket tab; if the server offers it, the tab runs an older build: call reload_ui (or ask the user to reload the page)`)
    let parsed = parseArgs(def, args)

    const ctx = {
      doc: this.doc,
      projectOps: this.ops.filter((o) => o.seq <= this.head).map((o) => o.op as Op),
      kernel: this.kernel.api(this.doc),
      render: this.renderer,
      renderBoard: this.boardRenderer,
      renderSchematic: this.schematicRenderer,
      download: async (name: string, blob: Blob) => download(name, blob),
      services,
    }

    if (def.kind === 'query') return def.run!(ctx, parsed as never)

    // Batches prepare each step.
    if (cmd === 'batch') {
      const steps = (parsed as { steps: { cmd: string; args: unknown }[] }).steps
      const prepared = []
      for (const [i, s] of steps.entries()) {
        const d = command(s.cmd)
        if (!d) throw new Error(`step ${i + 1}: unknown command "${s.cmd}" in this Ket tab; if the server offers it, the tab runs an older build: call reload_ui (or ask the user to reload the page)`)
        prepared.push({ cmd: s.cmd, args: d.prepare ? await d.prepare(ctx, parseArgs(d, s.args) as never) : s.args })
      }
      parsed = { steps: prepared }
    } else if (def.prepare) {
      parsed = await def.prepare(ctx, parsed as never)
    }

    const op: Op = { cmd, args: parsed }
    const out = applyOp(this.doc, op)
    return this.commitAndBuild(op, out.doc, out.summary, author)
  }

  private async commitAndBuild(op: Op, next: Doc, summary: string, author: string) {
    const prev = this.doc
    const base = this.head
    // Optimistic: show the change at once, roll back if the server refuses.
    this.doc = next
    let seq: number
    try {
      seq = await this.commit(op, base, author, summary)
    } catch (e) {
      this.doc = prev
      void this.rebuild()
      throw new Error(`not saved: ${(e as Error).message}`)
    }
    this.ops = this.ops.filter((o) => o.seq < seq)
    this.ops.push({ seq, op: op as StoredOp['op'], author, message: summary, created_at: new Date().toISOString() })
    this.head = seq
    this.top = seq
    this.log = [...this.log, { seq, cmd: op.cmd, summary, author, at: new Date().toISOString() }]

    const built = await this.rebuild()
    return report(summary, seq, built?.build, op)
  }

  /** The current board state (with DRC on request), for drawing. */
  async boardForRender(drc: boolean): Promise<BoardState | undefined> {
    return this.kernel.api(this.doc).board({ drc })
  }

  undo() {
    this.sendFrame({ t: 'undo', id: `u${++this.frameId}` })
  }

  redo() {
    this.sendFrame({ t: 'redo', id: `r${++this.frameId}` })
  }

  /** Answers a call from the server (MCP or the agent). */
  private async serveCall(f: Extract<Frame, { t: 'call' }>) {
    this.activity = { author: f.author, text: f.cmd, at: Date.now() }
    try {
      const result = await this.run(f.cmd, f.args, f.author)
      this.sendFrame({ t: 'result', id: f.id, ok: true, result: result ?? null })
    } catch (e) {
      this.sendFrame({ t: 'result', id: f.id, ok: false, error: (e as Error).message })
    }
  }
}

/** The answer of a mutation: what changed and how the model builds now. */
function report(summary: string, seq: number, build: BuildResult | undefined, op: Op) {
  if (!build) return { ok: false, change: summary, seq, error: 'the kernel failed to build' }
  const touched = new Set<string>()
  const steps = op.cmd === 'batch' ? (op.args as { steps: { args: unknown }[] }).steps : [{ args: op.args }]
  for (const s of steps) {
    const n = (s.args as { name?: string })?.name
    if (n) touched.add(n)
  }
  const failed = build.features.filter((f) => !f.ok)
  const warned = build.features.filter((f) => f.warnings?.length)
  return {
    ok: build.ok,
    change: summary,
    seq,
    parameter_error: build.parameterError,
    features: build.features
      .filter((f) => touched.has(f.name))
      .map((f) => ({ name: f.name, ok: f.ok, bbox: f.bbox, volume: f.volume, error: f.error, warnings: f.warnings })),
    failed: failed.length ? failed.map((f) => ({ name: f.name, error: f.error })) : undefined,
    warnings: warned.filter((f) => !touched.has(f.name)).length
      ? warned.filter((f) => !touched.has(f.name)).map((f) => ({ name: f.name, warnings: f.warnings }))
      : undefined,
    bodies: build.bodies,
  }
}

const services: Services = {
  async searchParts(query, limit) {
    const r = await fetch(`${base}/api/v1/parts/search?q=${encodeURIComponent(query)}&limit=${limit ?? 10}`)
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? r.statusText)
    return r.json()
  },
  async getPart(lcsc) {
    const r = await fetch(`${base}/api/v1/parts/${encodeURIComponent(lcsc)}`)
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? r.statusText)
    return r.json()
  },
  async offers(parts) {
    const r = await fetch(`${base}/api/v1/parts/offers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts }) })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? r.statusText)
    return r.json()
  },
  async getModel(uuid) {
    const r = await fetch(`${base}/api/v1/models/${encodeURIComponent(uuid)}`)
    if (!r.ok) throw new Error(r.statusText)
    return r.text()
  },
}

function download(name: string, blob: Blob): string {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return name
}
