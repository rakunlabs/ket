// Command registry: the one list of everything that can be done to a
// project. The UI, MCP clients and the built-in agent all go through it.
//
// A command validates its arguments with zod. Mutations return the next
// document; the session records {cmd, args} in the op log, and replaying
// the log rebuilds the document. Queries read the document or the kernel.

import { z } from 'zod'

import type { Doc, Selector, Track, Via } from './doc'
import type { BuildResult, CheckResult, EdgeInfo, FaceInfo, Kernel, MeshData } from './kernel'
import type { MotionPlan } from './motion'
import type { BoardState } from './pcb/state'
import type { ReplayFailure } from './operations'
import type { SolvedSketch } from './sketch'

export type Kind = 'mutate' | 'query'

/**
 * The kernel as commands see it: always async, because in the browser it
 * runs in a worker. Every call works on the document of the context.
 */
export interface KernelAPI {
  build(): Promise<BuildResult>
  faces(name: string, selector?: Selector): Promise<FaceInfo[]>
  edges(name: string, selector?: Selector): Promise<EdgeInfo[]>
  measure(name: string, other?: string): Promise<Record<string, unknown>>
  between(a: string | [number, number, number], b: string | [number, number, number]): Promise<Record<string, unknown>>
  checks(): Promise<CheckResult[]>
  sketch(name: string): Promise<SolvedSketch>
  /** The resolved board with DRC and ratsnest; undefined without a PCB. */
  board(opts?: { drc?: boolean }): Promise<BoardState | undefined>
  export(format: 'step' | 'stl' | '3mf', names: string[], models?: Record<string, string>): Promise<Blob>
  /** Solved gears: placement, sizes, ratios, warnings. */
  gears(): Promise<Record<string, unknown>[]>
  /** What Play moves. */
  motion(): Promise<MotionPlan>
  /** Runs physics headless; where loose bodies go. */
  simulate(seconds: number, samples: number): Promise<Record<string, unknown>>
  /** Steps the driven parameter and reports bodies that overlap. */
  sweep(opts: SweepOptions): Promise<Record<string, unknown>>
  /** Solved cams, geneva drives and belts. */
  mechanisms(): Promise<Record<string, unknown>[]>
  /** Routes the board with the built-in autorouter (in the kernel worker). */
  autoroute(opts: AutorouteOptions): Promise<AutorouteResult>
}

export interface AutorouteOptions {
  timeout?: number
  /** Nets left to pours. */
  skip?: string[]
  /** Only these nets (their old copper is replaced; the rest stays as obstacles). */
  nets?: string[]
}

export interface AutorouteResult {
  tracks: Track[]
  vias: Via[]
  nets: number
  seconds: number
  unrouted: string[]
  /** Solver runs (it reroutes with larger keepouts where DRC found new copper too close). */
  rounds: number
  /** DRC problems the new copper still has. */
  violations: string[]
}

export interface SweepOptions {
  from?: number
  to?: number
  steps?: number
  bodies?: string[]
  ignore?: [string, string][]
  min_volume?: number
}

/** Wraps an in-process Kernel (Node, tests) as a KernelAPI for doc. */
export function localKernel(kernel: Kernel, doc: Doc): KernelAPI {
  let built: BuildResult | undefined
  const build = async () => (built ??= (await kernel.prepareImports(doc), kernel.build(doc)))
  return {
    build,
    faces: async (n, s) => (await build(), kernel.faces(n, s)),
    edges: async (n, s) => (await build(), kernel.edges(n, s)),
    measure: async (n, o) => (await build(), kernel.measure(n, o)),
    between: async (a, b) => (await build(), kernel.between(a, b)),
    checks: async () => (await build(), kernel.checks(doc)),
    sketch: async (n) => (await build(), kernel.sketch(n)),
    board: async (o) => (await build(), kernel.boardState(doc, o)),
    export: async (f, names, models) => (await build(), kernel.export(f, names, models)),
    gears: async () => (await build(), kernel.gearReport()),
    motion: async () => (await build(), kernel.motion(doc)),
    simulate: async (s, n) => (await build(), kernel.simulate(doc, s, n)),
    sweep: async (o) => (await build(), kernel.sweep(doc, o)),
    mechanisms: async () => (await build(), kernel.mechanismReport()),
    autoroute: async (o) => (await build(), kernel.autoroute(doc, o)),
  }
}

/** What a command can use while running. */
export interface Ctx {
  doc: Doc
  /** Applied, prepared operations at the current head, without user/server metadata. */
  projectOps?: Op[]
  /** The document is the last good prefix, not the full stored history. */
  recovery?: ReplayFailure
  focus?(target: FocusTarget): void
  /** Isolated document context for dry runs; never commits or updates the UI. */
  kernelFor?(doc: Doc): KernelAPI
  revision?: number
  /** Interrupts only the local executor; saved operations are never undone. */
  interrupt?(): Promise<BuildResult | undefined>
  kernel: KernelAPI
  /** Renders views of the current model; only in the browser. */
  render?(opts: RenderOptions): Promise<{ images: { mime: string; data: string }[]; views: string[] }>
  /** Renders the 2D board; only in the browser. */
  renderBoard?(opts: BoardRenderOptions): Promise<{ images: { mime: string; data: string }[] }>
  /** Renders the schematic; only in the browser. */
  renderSchematic?(size: number): Promise<{ images: { mime: string; data: string }[] }>
  /** Saves a file for the user (export); only in the browser. */
  download?(name: string, blob: Blob): Promise<string>
  /** Server services (parts catalog, autorouter). */
  services?: Services
}

export interface FocusTarget {
  view: '3d' | 'pcb' | 'sch'
  objects: string[]
  at?: [number, number]
  side?: 'top' | 'bottom'
}

export interface Services {
  searchParts(query: string, limit?: number): Promise<unknown[]>
  /** Raw EasyEDA component response. */
  getPart(lcsc: string): Promise<unknown>
  /** EasyEDA OBJ text of a 3D model. */
  getModel?(uuid: string): Promise<string>
  /** Price and stock for quantities (LCSC → pieces); refreshed daily. */
  offers?(parts: Record<string, number>): Promise<Offer[]>
}

export interface Offer {
  lcsc: string
  mpn?: string
  basic: boolean
  stock?: number
  min?: number
  step?: number
  /** USD per piece at the ordered quantity. */
  unit?: number
  order: number
  checked: string
  error?: string
}

export interface BoardRenderOptions {
  size: number
  side: 'top' | 'bottom'
  ratsnest: boolean
  highlight?: string[]
  violations?: { at?: [number, number] }[]
}

export interface RenderOptions {
  views: string[]
  size: number
  highlight?: string[]
  hide?: string[]
  edges?: boolean
  labels?: boolean
  section?: { axis: 'X' | 'Y' | 'Z'; at: number }
  /** normal (CAD), realistic (materials, no edges), wireframe or xray. */
  shading?: 'normal' | 'realistic' | 'wireframe' | 'xray'
  /** Body name → display offset (exploded view). */
  offsets?: Record<string, [number, number, number]>
}

export interface MutateOut {
  doc: Doc
  /** Short summary for the op log and the model. */
  summary: string
}

export interface CommandDef<S extends z.ZodType = z.ZodType> {
  name: string
  group: string
  kind: Kind
  description: string
  args: S
  examples?: z.input<S>[]
  /** Mutations: compute the next document. Must be pure. */
  apply?(doc: Doc, args: z.output<S>): MutateOut
  /**
   * Mutations that need the outside world (a part's footprint, the
   * autorouter) resolve it here, before apply. The returned arguments are
   * what the op log records, so replay stays pure and deterministic.
   */
  prepare?(ctx: Ctx, args: z.output<S>): Promise<z.output<S>>
  /** Argument fields filled by prepare; hidden from tool schemas. */
  internal?: string[]
  /** Queries: compute an answer. */
  run?(ctx: Ctx, args: z.output<S>): unknown | Promise<unknown>
}

const registry = new Map<string, CommandDef>()

export function define<S extends z.ZodType>(def: CommandDef<S>): CommandDef<S> {
  if (registry.has(def.name)) throw new Error(`command ${def.name} is defined twice`)
  if (def.kind === 'mutate' && !def.apply) throw new Error(`mutation ${def.name} needs apply`)
  if (def.kind === 'query' && !def.run) throw new Error(`query ${def.name} needs run`)
  registry.set(def.name, def as unknown as CommandDef)
  return def
}

export function command(name: string): CommandDef | undefined {
  return registry.get(name)
}

export function commands(): CommandDef[] {
  return [...registry.values()]
}

/** Turns a zod error into one line per problem with its path. */
export function argError(name: string, err: z.ZodError): string {
  const lines = err.issues.map((i) => {
    const path = i.path.length ? i.path.join('.') : '(arguments)'
    return `${path}: ${i.message}`
  })
  return `invalid arguments for ${name}:\n- ${lines.join('\n- ')}`
}

export function parseArgs(def: CommandDef, args: unknown): unknown {
  const r = def.args.safeParse(args ?? {})
  if (!r.success) throw new Error(argError(def.name, r.error))
  return r.data
}

/** One recorded operation: a command and its validated arguments. */
export type Op = { cmd: string; args: unknown }

/** Replays one op onto a document. Throws if the op no longer applies. */
export function applyOp(doc: Doc, op: Op): MutateOut {
  const def = registry.get(op.cmd)
  if (!def) throw new Error(`unknown command "${op.cmd}"`)
  if (def.kind !== 'mutate') throw new Error(`${op.cmd} is a query and cannot be applied`)
  return def.apply!(doc, parseArgs(def, op.args) as never)
}

export type { CheckResult, MeshData }
