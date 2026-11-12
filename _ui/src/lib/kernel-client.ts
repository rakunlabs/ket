// Client of the kernel worker. Builds are serialized: the worker keeps the
// last built document, so queries always run against what was built last.

import type { Doc, Selector } from '../engine/doc'
import type { BuildResult, CheckResult, EdgeInfo, FaceInfo, MeshData, SketchLines } from '../engine/kernel'
import type { AutorouteOptions, AutorouteResult, KernelAPI, SweepOptions } from '../engine/registry'
import type { MotionPlan } from '../engine/motion'
import type { SolvedSketch } from '../engine/sketch'
import type { BoardState } from '../engine/pcb/state'
import type { WorkerRequest } from '../engine/worker'
import { base } from './api'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

type Req = WorkerRequest extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never

export interface Built {
  build: BuildResult
  meshes: MeshData[]
  sketches: SketchLines[]
  board?: BoardState
}

export class KernelClient {
  private worker!: Worker
  private generation = 0
  private closed = false
  private failed = false
  private pending = new Map<number, Pending>()
  private nextId = 1
  private queue: Promise<unknown> = Promise.resolve()
  /** A build and its following query are one transaction, including dry runs. */
  private documentQueue: Promise<unknown> = Promise.resolve()
  /** The doc the worker holds right now. */
  private builtDoc: Doc | undefined
  private lastBuilt: Built | undefined

  constructor() {
    this.startWorker()
  }

  private startWorker() {
    this.failed = false
    this.worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(ev.data.id)
      if (!p) return
      this.pending.delete(ev.data.id)
      clearTimeout(p.timer)
      if (ev.data.ok) p.resolve(ev.data.result)
      else p.reject(new Error(ev.data.error))
    }
    this.worker.onerror = (ev) => {
      // Do not loop forever if the worker script itself fails to load.
      // The next explicit request will start a fresh worker.
      this.restart(`kernel worker failed: ${ev.message}; retry to start a fresh kernel`, false)
    }
  }

  restart(reason = 'operation cancelled; the kernel was restarted, saved operations are preserved', start = true) {
    if (this.closed) return
    this.generation++
    this.worker.terminate()
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)) }
    this.pending.clear()
    this.builtDoc = undefined
    this.lastBuilt = undefined
    this.queue = Promise.resolve()
    this.documentQueue = Promise.resolve()
    this.failed = !start
    if (start) this.startWorker()
  }

  dispose() {
    this.closed = true
    this.generation++
    this.worker.terminate()
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('the project was closed')) }
    this.pending.clear()
  }

  private send<T>(req: Req): Promise<T> {
    const generation = this.generation
    const run = () =>
      new Promise<T>((resolve, reject) => {
        if (this.closed || generation !== this.generation) return reject(new Error('operation cancelled or project closed; retry against the current design'))
        if (this.failed) this.startWorker()
        const id = this.nextId++
        const timeout = req.type === 'autoroute' ? ((req.opts.timeout ?? 180) + 60) * 1000 : 5 * 60 * 1000
        const timer = setTimeout(() => this.restart(`${req.type} exceeded ${Math.round(timeout / 1000)} seconds; the kernel was restarted. Saved operations are preserved; inspect get_document and retry with simpler geometry.`), timeout)
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        this.worker.postMessage({ ...req, id })
      })
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }

  /** Builds doc unless it is the one built last. */
  build(doc: Doc): Promise<Built> {
    return this.atomic(() => this.buildDocument(doc))
  }

  private atomic<T>(work: () => Promise<T>): Promise<T> {
    const generation = this.generation
    const result = this.documentQueue.then(() => {
      if (this.closed || generation !== this.generation) throw new Error('operation cancelled or project closed; retry against the current design')
      return work()
    })
    this.documentQueue = result.catch(() => undefined)
    return result
  }

  private async buildDocument(doc: Doc): Promise<Built> {
    if (this.builtDoc === doc && this.lastBuilt) return this.lastBuilt
    // structuredClone through postMessage; $state proxies must be unwrapped.
    const plain = JSON.parse(JSON.stringify(doc)) as Doc
    const out = await this.send<Built>({ type: 'build', doc: plain, assets: `${location.origin}${base}/api/v1/assets` })
    this.builtDoc = doc
    this.lastBuilt = out
    return out
  }

  /** A KernelAPI bound to doc, for commands. */
  api(doc: Doc, onBuilt?: (b: Built) => void): KernelAPI {
    const query = <T>(req: Req): Promise<T> => this.atomic(async () => {
      const b = await this.buildDocument(doc)
      onBuilt?.(b)
      return this.send<T>(req)
    })
    return {
      build: () => this.atomic(async () => { const b = await this.buildDocument(doc); onBuilt?.(b); return b.build }),
      faces: (name: string, selector?: Selector) => query<FaceInfo[]>({ type: 'faces', name, selector }),
      edges: (name: string, selector?: Selector) => query<EdgeInfo[]>({ type: 'edges', name, selector }),
      measure: (name: string, other?: string) => query<Record<string, unknown>>({ type: 'measure', name, other }),
      between: async (a: string | [number, number, number], b: string | [number, number, number]) =>
        query<Record<string, unknown>>({ type: 'between', a, b }),
      checks: () => query<CheckResult[]>({ type: 'checks' }),
      solids: (name: string) => query<Record<string, unknown>[]>({ type: 'solids', name }),
      section: (names: string[], axis: 'X' | 'Y' | 'Z', at: number) => query<Record<string, unknown>[]>({ type: 'section', names, axis, at }),
      sketch: (name: string) => query<SolvedSketch>({ type: 'sketch', name }),
      board: (o?: { drc?: boolean }) => query<BoardState | undefined>({ type: 'board', drc: o?.drc }),
      export: (format: 'step' | 'stl' | '3mf', names: string[], models?: Record<string, string>) => query<Blob>({ type: 'export', format, names, models }),
      gears: () => query<Record<string, unknown>[]>({ type: 'gears' }),
      motion: () => query<MotionPlan>({ type: 'motion' }),
      simulate: (seconds: number, samples: number) => query<Record<string, unknown>>({ type: 'simulate', seconds, samples }),
      sweep: (opts: SweepOptions) => query<Record<string, unknown>>({ type: 'sweep', opts }),
      mechanisms: () => query<Record<string, unknown>[]>({ type: 'mechanisms' }),
      autoroute: (opts: AutorouteOptions) => query<AutorouteResult>({ type: 'autoroute', opts }),
    }
  }
}
