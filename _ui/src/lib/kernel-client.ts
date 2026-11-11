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

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

type Req = WorkerRequest extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never

export interface Built {
  build: BuildResult
  meshes: MeshData[]
  sketches: SketchLines[]
  board?: BoardState
}

export class KernelClient {
  private worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' })
  private pending = new Map<number, Pending>()
  private nextId = 1
  private queue: Promise<unknown> = Promise.resolve()
  /** The doc the worker holds right now. */
  private builtDoc: Doc | undefined
  private lastBuilt: Built | undefined

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(ev.data.id)
      if (!p) return
      this.pending.delete(ev.data.id)
      if (ev.data.ok) p.resolve(ev.data.result)
      else p.reject(new Error(ev.data.error))
    }
    this.worker.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(`kernel worker failed: ${ev.message}`))
      this.pending.clear()
    }
  }

  dispose() {
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error('the project was closed'))
    this.pending.clear()
  }

  private send<T>(req: Req): Promise<T> {
    const run = () =>
      new Promise<T>((resolve, reject) => {
        const id = this.nextId++
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        this.worker.postMessage({ ...req, id })
      })
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }

  /** Builds doc unless it is the one built last. */
  async build(doc: Doc): Promise<Built> {
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
    const ensure = async () => {
      const b = await this.build(doc)
      onBuilt?.(b)
      return b
    }
    return {
      build: async () => (await ensure()).build,
      faces: async (name: string, selector?: Selector) => (await ensure(), this.send<FaceInfo[]>({ type: 'faces', name, selector })),
      edges: async (name: string, selector?: Selector) => (await ensure(), this.send<EdgeInfo[]>({ type: 'edges', name, selector })),
      measure: async (name: string, other?: string) => (await ensure(), this.send<Record<string, unknown>>({ type: 'measure', name, other })),
      between: async (a: string | [number, number, number], b: string | [number, number, number]) =>
        (await ensure(), this.send<Record<string, unknown>>({ type: 'between', a, b })),
      checks: async () => (await ensure(), this.send<CheckResult[]>({ type: 'checks' })),
      sketch: async (name: string) => (await ensure(), this.send<SolvedSketch>({ type: 'sketch', name })),
      board: async (o?: { drc?: boolean }) => (await ensure(), this.send<BoardState | undefined>({ type: 'board', drc: o?.drc })),
      export: async (format: 'step' | 'stl', names: string[], models?: Record<string, string>) => (await ensure(), this.send<Blob>({ type: 'export', format, names, models })),
      gears: async () => (await ensure(), this.send<Record<string, unknown>[]>({ type: 'gears' })),
      motion: async () => (await ensure(), this.send<MotionPlan>({ type: 'motion' })),
      simulate: async (seconds: number, samples: number) => (await ensure(), this.send<Record<string, unknown>>({ type: 'simulate', seconds, samples })),
      sweep: async (opts: SweepOptions) => (await ensure(), this.send<Record<string, unknown>>({ type: 'sweep', opts })),
      mechanisms: async () => (await ensure(), this.send<Record<string, unknown>[]>({ type: 'mechanisms' })),
      autoroute: async (opts: AutorouteOptions) => (await ensure(), this.send<AutorouteResult>({ type: 'autoroute', opts })),
    }
  }
}
