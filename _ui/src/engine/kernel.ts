// The kernel turns a Doc into solids with OpenCascade (through replicad).
// It runs in a Web Worker in the browser and directly in Node for tests.
//
// Every feature is rebuilt only when its resolved definition or one of its
// inputs changed. replicad operations consume their inputs, so the cache
// keeps a master copy of each shape and every use works on a clone.

import * as R from 'replicad'
import type { AnyShape, Edge, EdgeFinder, Face, FaceFinder, Shape3D } from 'replicad'

import { type Check, type Doc, type Expr, type Feature, type Model3D, type Plane, type Profile, type Selector, type Sketch, type Vec3E, bodies, inputsOf, sketchesOf } from './doc'
import { num, resolveParameters } from './expr'
import { type ResolvedBoard, resolveBoard } from './pcb/board'
import { drc, ratsnest } from './pcb/drc'
import { parseOBJ, placeModel } from './pcb/model3d'
import { type ZoneFill, fillZones } from './pcb/zones'
import type { BoardState } from './pcb/state'
import { type Loop, type SolvedSketch, loopInside, solveSketch } from './sketch'

export type V3 = [number, number, number]
export type BBox = [V3, V3]

export interface FeatureStatus {
  name: string
  type: Feature['type']
  ok: boolean
  error?: string
  warnings?: string[]
  bbox?: BBox
  volume?: number
  solids?: number
  faces?: number
  edges?: number
}

export interface SketchStatus {
  name: string
  plane: Plane
  ok: boolean
  status: SolvedSketch['status']
  dof: number
  loops: number
  message?: string
}

export interface BuildResult {
  ok: boolean
  sketches: SketchStatus[]
  /** Parameter values after resolving expressions. */
  parameters: Record<string, number>
  parameterError?: string
  features: FeatureStatus[]
  /** Names of the visible result bodies. */
  bodies: string[]
}

export interface MeshData {
  name: string
  key: string
  color?: string
  vertices: Float32Array
  normals: Float32Array
  triangles: Uint32Array
  edges: Float32Array
  /** edgeGroups[i] = [start, count] in points of edges for B-rep edge i;
   *  the ruler snaps to their ends, midpoints and arc centers. */
  edgeGroups: Uint32Array
  /** faceGroups[i] = [start, count] in triangles for face i. */
  faceGroups: Uint32Array
  /** 0..1, from the feature; 1 when unset. */
  opacity?: number
}

export interface SketchLines {
  name: string
  ok: boolean
  dof: number
  /** Consumed by a feature; drawn faintly. */
  used: boolean
  lines: Float32Array
  construction: Float32Array
}

export interface CheckResult {
  name: string
  kind: Check['kind']
  ok: boolean
  /** What was measured, e.g. "distance 0.40 mm < 1.00 mm". */
  detail: string
  note?: string
}

export interface FaceInfo {
  index: number
  type: string
  center: V3
  normal?: V3
  area: number
}

export interface EdgeInfo {
  index: number
  type: string
  start: V3
  end: V3
  length: number
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d
const r3 = (v: V3): V3 => [round(v[0]), round(v[1]), round(v[2])]

function bboxOf(s: AnyShape): BBox {
  const [a, b] = s.boundingBox.bounds as [V3, V3]
  return [r3(a), r3(b)]
}

function volumeOf(s: Shape3D): number {
  try {
    return R.measureVolume(s)
  } catch {
    return 0
  }
}

/** OpenCascade throws WebAssembly exceptions without a message. */
function kernelMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string') return e
  return 'OpenCascade could not compute this operation'
}

const SURFACE_TYPES: Record<string, string> = {
  plane: 'PLANE',
  cylinder: 'CYLINDRE',
  cone: 'CONE',
  sphere: 'SPHERE',
  torus: 'TORUS',
  bspline: 'BSPLINE_SURFACE',
  bezier: 'BEZIER_SURFACE',
  revolution: 'REVOLUTION_SURFACE',
  extrusion: 'EXTRUSION_SURFACE',
  offset: 'OFFSET_SURFACE',
}

const CURVE_TYPES: Record<string, string> = {
  line: 'LINE',
  circle: 'CIRCLE',
  ellipse: 'ELLIPSE',
  hyperbola: 'HYPERBOLA',
  parabola: 'PARABOLA',
  bezier: 'BEZIER_CURVE',
  bspline: 'BSPLINE_CURVE',
}

function friendlyType(t: string): string {
  for (const [k, v] of Object.entries({ ...SURFACE_TYPES, ...CURVE_TYPES })) if (v === t) return k
  return t.toLowerCase()
}

const AXES: Record<string, V3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2])

function centerOf(el: Face | Edge): V3 {
  const [a, b] = el.boundingBox.bounds as [V3, V3]
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
}

function directionOf(el: Face | Edge, isFace: boolean): V3 | undefined {
  try {
    if (isFace) return (el as Face).normalAt().toTuple() as V3
    return (el as Edge).tangentAt(0.5).toTuple() as V3
  } catch {
    return undefined
  }
}

/**
 * One selector term in CadQuery's string syntax, which models know well:
 *   >Z / <Z   the elements farthest along +Z / -Z (by center)
 *   +Z / -Z   faces whose normal points along +Z / -Z
 *   |Z        faces: normal parallel to Z; edges: edge parallel to Z
 *   #Z        faces: normal perpendicular to Z; edges: edge perpendicular to Z
 *   all
 */
function termFilter(term: string, all: (Face | Edge)[], isFace: boolean): (el: Face | Edge) => boolean {
  const t = term.trim()
  if (t === 'all' || t === '') return () => true
  if (t.startsWith('not ')) {
    const f = termFilter(t.slice(4), all, isFace)
    return (el) => !f(el)
  }

  const m = /^([<>+\-|#])([XYZ])$/.exec(t)
  if (!m) {
    throw new Error(`unknown selector "${term}": use >Z <Z +Z -Z |Z #Z (any axis X Y Z), "all", "not ...", joined with " and "`)
  }
  const [, op, ax] = m
  const axis = AXES[ax]
  const tol = 1e-3

  switch (op) {
    case '>':
    case '<': {
      const vals = all.map((el) => dot(centerOf(el), axis))
      const ext = op === '>' ? Math.max(...vals) : Math.min(...vals)
      return (el) => Math.abs(dot(centerOf(el), axis) - ext) < tol
    }
    case '+':
    case '-': {
      if (!isFace) throw new Error(`"${term}" applies to faces; for edges use >${ax}, <${ax}, |${ax} or #${ax}`)
      const sign = op === '+' ? 1 : -1
      return (el) => {
        const d = directionOf(el, true)
        return !!d && dot(d, axis) * sign > 1 - tol
      }
    }
    case '|':
      return (el) => {
        const d = directionOf(el, isFace)
        return !!d && Math.abs(Math.abs(dot(d, axis)) / (norm(d) || 1) - 1) < tol
      }
    case '#':
      return (el) => {
        const d = directionOf(el, isFace)
        return !!d && Math.abs(dot(d, axis)) / (norm(d) || 1) < tol
      }
  }

  return () => true
}

/** Elements of shape matched by a selector. */
function selectElements(shape: AnyShape, sel: Selector | undefined, isFace: boolean, params: Map<string, number>, what: string): (Face | Edge)[] {
  const { all, picked } = selectIndexed(shape, sel, isFace, params, what)
  return picked.map((i) => all[i])
}

/** Like selectElements, but returns indices into one list of elements. */
function selectIndexed(
  shape: AnyShape,
  sel: Selector | undefined,
  isFace: boolean,
  params: Map<string, number>,
  what = 'selector',
): { all: (Face | Edge)[]; picked: number[] } {
  const all: (Face | Edge)[] = isFace ? shape.faces : shape.edges
  const idx = all.map((_, i) => i)
  if (!sel) return { all, picked: idx }

  let out = idx
  if (sel.where) {
    for (const term of sel.where.split(/\s+and\s+/)) {
      const f = termFilter(term, all, isFace)
      out = out.filter((i) => f(all[i]))
    }
  }
  if (sel.type) {
    const want = (isFace ? SURFACE_TYPES : CURVE_TYPES)[sel.type.toLowerCase()]
    if (!want) {
      throw new Error(`${what}: unknown ${isFace ? 'face' : 'edge'} type "${sel.type}"; use one of ${Object.keys(isFace ? SURFACE_TYPES : CURVE_TYPES).join(', ')}`)
    }
    out = out.filter((i) => all[i].geomType === want)
  }
  if (sel.inBox) {
    const a = vec(sel.inBox[0], params, `${what}.inBox[0]`)
    const b = vec(sel.inBox[1], params, `${what}.inBox[1]`)
    const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])]
    const hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])]
    out = out.filter((i) => {
      const c = centerOf(all[i])
      return c.every((v, k) => v >= lo[k] - 1e-6 && v <= hi[k] + 1e-6)
    })
  }
  if (sel.near) {
    const p = vec(sel.near, params, `${what}.near`)
    const probe = R.makeSphere(0.001).translate(p[0], p[1], p[2])
    out = out.filter((i) => {
      try {
        return R.measureDistanceBetween(all[i], probe) < 0.01
      } catch {
        return false
      }
    })
    probe.delete()
  }

  return { all, picked: out }
}

function finderOf<T extends FaceFinder | EdgeFinder>(list: (Face | Edge)[]) {
  return (f: T) => (f as FaceFinder & EdgeFinder).inList(list as never) as T
}

function vec(v: Vec3E | undefined, params: Map<string, number>, what: string, fallback: V3 = [0, 0, 0]): V3 {
  if (!v) return fallback
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${what} must be [x, y, z]`)
  return [num(v[0], params, `${what}[0]`), num(v[1], params, `${what}[1]`), num(v[2], params, `${what}[2]`)]
}

function place(s: Shape3D, f: { translate?: Vec3E; rotate?: Vec3E }, params: Map<string, number>, what: string): Shape3D {
  const [rx, ry, rz] = vec(f.rotate, params, `${what}.rotate`)
  if (rx) s = s.rotate(rx, [0, 0, 0], [1, 0, 0])
  if (ry) s = s.rotate(ry, [0, 0, 0], [0, 1, 0])
  if (rz) s = s.rotate(rz, [0, 0, 0], [0, 0, 1])
  const [tx, ty, tz] = vec(f.translate, params, `${what}.translate`)
  if (tx || ty || tz) s = s.translate(tx, ty, tz)
  return s
}

/** A 2D outline from a profile (rect, circle, slot, polygon). */
function profileDrawing(p: NonNullable<Extract<Feature, { type: 'extrude' }>['profile']>, params: Map<string, number>, what: string): R.Drawing {
  const c2 = (c: [unknown, unknown] | undefined, w: string): [number, number] =>
    c ? [num(c[0] as never, params, `${w}[0]`), num(c[1] as never, params, `${w}[1]`)] : [0, 0]

  let drawing: R.Drawing
  switch (p.kind) {
    case 'rect': {
      const w = num(p.w, params, `${what}.profile.w`)
      const h = num(p.h, params, `${what}.profile.h`)
      const r = num(p.r, params, `${what}.profile.r`, 0)
      if (w <= 0 || h <= 0) throw new Error(`${what}: profile w and h must be > 0 (got ${w} × ${h})`)
      if (r * 2 > Math.min(w, h)) throw new Error(`${what}: profile corner r=${r} is more than half the smaller side (${Math.min(w, h)})`)
      drawing = R.drawRoundedRectangle(w, h, r || undefined)
      const [cx, cy] = c2(p.center, `${what}.profile.center`)
      if (cx || cy) drawing = drawing.translate(cx, cy)
      return drawing
    }
    case 'circle': {
      const r = num(p.r, params, `${what}.profile.r`)
      if (r <= 0) throw new Error(`${what}: profile r must be > 0`)
      drawing = R.drawCircle(r)
      const [cx, cy] = c2(p.center, `${what}.profile.center`)
      if (cx || cy) drawing = drawing.translate(cx, cy)
      return drawing
    }
    case 'slot': {
      const len = num(p.length, params, `${what}.profile.length`)
      const wid = num(p.width, params, `${what}.profile.width`)
      if (len < wid) throw new Error(`${what}: slot length (${len}) must be ≥ width (${wid})`)
      drawing = R.drawRoundedRectangle(len, wid, wid / 2 - 1e-6)
      const ang = num(p.angle, params, `${what}.profile.angle`, 0)
      if (ang) drawing = drawing.rotate(ang)
      const [cx, cy] = c2(p.center, `${what}.profile.center`)
      if (cx || cy) drawing = drawing.translate(cx, cy)
      return drawing
    }
    case 'polygon': {
      if (!p.points || p.points.length < 3) throw new Error(`${what}: polygon needs at least 3 points`)
      const pts = p.points.map((pt, i) => c2(pt, `${what}.profile.points[${i}]`))
      let pen = R.draw(pts[0])
      for (const pt of pts.slice(1)) pen = pen.lineTo(pt)
      return pen.close()
    }
    default:
      throw new Error(`${what}: unknown profile kind "${(p as { kind: string }).kind}"; use rect, circle, slot or polygon`)
  }
}

function loopDrawing(loop: Loop): R.Drawing {
  const first = loop.segments[0]
  if (first.kind === 'circle') return R.drawCircle(first.r).translate(first.c[0], first.c[1])
  let pen = R.draw(first.from)
  for (const s of loop.segments) {
    if (s.kind === 'line') pen = pen.lineTo(s.to)
    else if (s.kind === 'arc') pen = pen.threePointsArcTo(s.to, s.mid)
  }
  return pen.close()
}

/**
 * The outline of a solved sketch: the largest loop, minus every loop
 * inside it (holes). Other loops outside it are added as separate regions.
 */
function sketchDrawing(sk: SolvedSketch, what: string): R.Drawing {
  if (!sk.ok) throw new Error(`${what}: sketch ${sk.name} does not solve: ${sk.message}`)
  if (!sk.loops.length) {
    throw new Error(
      `${what}: sketch ${sk.name} has no closed outline. Lines and arcs must join end to end (share points) to form a loop; construction entities do not count.`,
    )
  }
  const outers: { loop: Loop; holes: Loop[] }[] = []
  for (const loop of sk.loops) {
    const parent = outers.find((o) => loopInside(loop, o.loop) && !o.holes.some((h) => loopInside(loop, h)))
    if (parent) parent.holes.push(loop)
    else outers.push({ loop, holes: [] })
  }
  let out: R.Drawing | undefined
  for (const o of outers) {
    let d = loopDrawing(o.loop)
    for (const h of o.holes) d = d.cut(loopDrawing(h))
    out = out ? out.fuse(d) : d
  }
  return out!
}

/** replicad's XZ plane normal is -Y; flip so every plane works along +axis. */
function onPlane(d: R.Drawing, plane: Plane, offset: number): R.Sketch | R.Sketches {
  const flip = plane === 'XZ' ? -1 : 1
  return d.sketchOnPlane(plane, offset * flip) as R.Sketch | R.Sketches
}

const PLANE_AXES: Record<Plane, ['X' | 'Y' | 'Z', 'X' | 'Y' | 'Z', 'X' | 'Y' | 'Z']> = {
  XY: ['X', 'Y', 'Z'],
  XZ: ['X', 'Z', 'Y'],
  YZ: ['Y', 'Z', 'X'],
}

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2])
const norm3 = (a: V3): V3 => mul3(a, 1 / (len3(a) || 1))

/**
 * A sweep path: straight segments through the points, with each inner
 * corner rounded to radius bend (0 = sharp corners).
 */
function pathWire(pts: V3[], bend: number, what: string): R.Wire {
  for (let i = 1; i < pts.length; i++) {
    if (len3(sub3(pts[i], pts[i - 1])) < 1e-6) throw new Error(`${what}.path: points ${i - 1} and ${i} are the same`)
  }
  // Per corner: tangent points and the arc's middle.
  const corners: ({ a: V3; m: V3; b: V3 } | undefined)[] = pts.map(() => undefined)
  const used = pts.map(() => 0)
  if (bend > 0) {
    for (let i = 1; i + 1 < pts.length; i++) {
      const d1 = norm3(sub3(pts[i], pts[i - 1]))
      const d2 = norm3(sub3(pts[i + 1], pts[i]))
      const cos = Math.max(-1, Math.min(1, dot3(d1, d2)))
      const turn = Math.acos(cos)
      if (turn < 1e-4) continue
      if (Math.PI - turn < 1e-3) throw new Error(`${what}.path: the path turns back on itself at point ${i}`)
      const t = bend * Math.tan(turn / 2)
      used[i] = t
      const a = sub3(pts[i], mul3(d1, t))
      const b = add3(pts[i], mul3(d2, t))
      const bis = norm3(sub3(d2, d1))
      const c = add3(pts[i], mul3(bis, bend / Math.cos(turn / 2)))
      const m = sub3(c, mul3(bis, bend))
      corners[i] = { a, m, b }
    }
    for (let i = 1; i < pts.length; i++) {
      const l = len3(sub3(pts[i], pts[i - 1]))
      if (used[i - 1] + used[i] > l + 1e-6) {
        throw new Error(`${what}: bend ${bend} is too large for the segment from point ${i - 1} to ${i} (${round(l, 3)} mm long); use a smaller bend or longer segments`)
      }
    }
  }
  const edges: Edge[] = []
  let cur = pts[0]
  for (let i = 1; i < pts.length; i++) {
    const c = corners[i]
    const end = c ? c.a : pts[i]
    if (len3(sub3(end, cur)) > 1e-6) edges.push(R.makeLine(cur, end))
    if (c) {
      edges.push(R.makeThreePointArc(c.a, c.m, c.b))
      cur = c.b
    } else cur = end
  }
  return R.assembleWire(edges)
}

/** Body names the board adds to the model. */
export const BOARD = 'board'
export const PART_PREFIX = 'part_'

function polyDrawing(poly: { x: number; y: number }[]): R.Drawing {
  let pen = R.draw([poly[0].x, poly[0].y])
  for (const p of poly.slice(1)) pen = pen.lineTo([p.x, p.y])
  return pen.close()
}

interface CacheEntry {
  key: string
  shape: Shape3D
  status: FeatureStatus
}

export class Kernel {
  private cache = new Map<string, CacheEntry>()
  private meshCache = new Map<string, MeshData>()
  private params = new Map<string, number>()
  private doc: Doc | undefined

  private solved = new Map<string, { key: string; sketch: SolvedSketch; error?: string }>()

  /** Solves (or reuses) a sketch by name. */
  sketch(name: string): SolvedSketch {
    const s = this.doc?.sketches.find((x) => x.name === name)
    if (!s) {
      const known = this.doc?.sketches.map((x) => x.name) ?? []
      throw new Error(`no sketch "${name}"; sketches are: ${known.join(', ') || '(none; create one with sketch)'}`)
    }
    const key = JSON.stringify([s, Object.fromEntries(this.params)])
    const hit = this.solved.get(name)
    if (hit && hit.key === key) {
      if (hit.error) throw new Error(hit.error)
      return hit.sketch
    }
    try {
      const sk = solveSketch(s, this.params)
      this.solved.set(name, { key, sketch: sk })
      return sk
    } catch (e) {
      const msg = (e as Error).message
      this.solved.set(name, { key, sketch: undefined as never, error: msg })
      throw e
    }
  }

  private outline(f: { name: string; sketch?: string; profile?: Profile; plane?: Plane; offset?: Expr }): { drawing: R.Drawing; plane: Plane; offset: number } {
    const p = this.params
    if (f.sketch) {
      if (f.profile) throw new Error('use either sketch or profile, not both')
      const s = this.doc!.sketches.find((x) => x.name === f.sketch) as Sketch | undefined
      const sk = this.sketch(f.sketch)
      return { drawing: sketchDrawing(sk, f.name), plane: s!.plane, offset: num(s!.offset, p, `sketch ${s!.name}.offset`, 0) }
    }
    if (!f.profile) throw new Error('needs a sketch (name of a sketch) or a profile (rect, circle, slot, polygon)')
    if (!f.plane) throw new Error('a profile needs a plane: XY, XZ or YZ')
    return { drawing: profileDrawing(f.profile, p, f.name), plane: f.plane, offset: num(f.offset, p, `${f.name}.offset`, 0) }
  }

  /** Solves every sketch for the build result. */
  private sketchStatus(doc: Doc): SketchStatus[] {
    return doc.sketches.map((s) => {
      try {
        const sk = this.sketch(s.name)
        return {
          name: s.name,
          plane: s.plane,
          ok: sk.ok,
          status: sk.status,
          dof: sk.dof,
          loops: sk.loops.length,
          message: sk.message,
        }
      } catch (e) {
        return { name: s.name, plane: s.plane, ok: false, status: 'failed', dof: 0, loops: 0, message: (e as Error).message }
      }
    })
  }

  /** Rebuilds the document, reusing unchanged features. */
  build(doc: Doc): BuildResult {
    this.doc = doc
    const result: BuildResult = { ok: true, parameters: {}, features: [], bodies: [], sketches: [] }

    try {
      this.params = resolveParameters(doc.parameters)
    } catch (e) {
      this.params = new Map()
      result.ok = false
      result.parameterError = (e as Error).message
    }
    for (const [k, v] of this.params) result.parameters[k] = round(v, 6)

    result.sketches = this.sketchStatus(doc)
    for (const name of [...this.solved.keys()]) if (!doc.sketches.some((s) => s.name === name)) this.solved.delete(name)

    const keys = new Map<string, string>()
    const seen = new Set<string>()

    for (const f of doc.features) {
      if (seen.has(f.name)) {
        result.ok = false
        result.features.push({ name: f.name, type: f.type, ok: false, error: `duplicate feature name "${f.name}"` })
        continue
      }
      seen.add(f.name)

      const inputs = inputsOf(f)
      const missing = inputs.filter((i) => !keys.has(i))
      if (missing.length) {
        const st: FeatureStatus = {
          name: f.name,
          type: f.type,
          ok: false,
          error: `uses ${missing.map((m) => `"${m}"`).join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} missing, defined later or failed`,
        }
        result.ok = false
        result.features.push(st)
        this.drop(f.name)
        continue
      }

      // The key covers the definition with parameters substituted and the
      // keys of the inputs, so any upstream change rebuilds this feature.
      let key: string
      try {
        const sk = sketchesOf(f).map((n) => doc.sketches.find((x) => x.name === n))
        key = JSON.stringify([f, this.usedParams(f), sk]) + '|' + inputs.map((i) => keys.get(i)).join('|')
      } catch (e) {
        key = String(Math.random())
      }

      const cached = this.cache.get(f.name)
      if (cached && cached.key === key) {
        keys.set(f.name, key)
        result.features.push(cached.status)
        if (!cached.status.ok) result.ok = false
        continue
      }

      this.drop(f.name)
      let shape: Shape3D | undefined
      let status: FeatureStatus
      try {
        const warnings: string[] = []
        shape = this.make(f, warnings)
        status = this.describe(f, shape, warnings)
      } catch (e) {
        status = { name: f.name, type: f.type, ok: false, error: `${f.name} (${f.type}): ${kernelMessage(e)}${this.hint(f, e)}` }
      }

      if (shape && status.ok) {
        this.cache.set(f.name, { key, shape, status })
        keys.set(f.name, key)
      } else {
        result.ok = false
        shape?.delete()
      }
      result.features.push(status)
    }

    // Forget features that no longer exist.
    for (const name of [...this.cache.keys()]) {
      if (!seen.has(name) && name !== BOARD && !name.startsWith(PART_PREFIX)) this.drop(name)
    }

    result.bodies = bodies(doc)
      .map((f) => f.name)
      .filter((n) => this.cache.has(n))

    this.buildBoard(doc, result)

    return result
  }

  private board: ResolvedBoard | undefined
  private boardKey = ''

  /** The PCB as solids: "board" (FR4 with holes) and one block per part. */
  private buildBoard(doc: Doc, result: BuildResult) {
    if (!doc.pcb) {
      this.board = undefined
      for (const n of [...this.cache.keys()]) if (n === BOARD || n.startsWith(PART_PREFIX)) this.drop(n)
      return
    }
    const b = resolveBoard(doc, this.params, (n) => this.sketch(n))
    this.board = b
    const key = JSON.stringify([b.outline, b.cutouts, b.thickness, b.z, b.holes, b.components.map((c) => [c.ref, c.at, c.rotation, c.side, c.courtyard, c.height])])
    if (key !== this.boardKey) {
      this.boardKey = key
      for (const n of [...this.cache.keys()]) if (n === BOARD || n.startsWith(PART_PREFIX)) this.drop(n)
      if (b.outline.length >= 3) {
        try {
          let d = polyDrawing(b.outline)
          for (const c of b.cutouts) d = d.cut(polyDrawing(c))
          for (const h of b.holes) d = d.cut(R.drawCircle(h.d / 2).translate(h.at.x, h.at.y))
          const solid = (d.sketchOnPlane('XY', b.z) as R.Sketch).extrude(b.thickness) as Shape3D
          this.cache.set(BOARD, { key, shape: solid, status: this.describe({ name: BOARD, type: 'extrude' } as Feature, solid, []) })
        } catch (e) {
          result.ok = false
          result.features.push({ name: BOARD, type: 'extrude', ok: false, error: `board: ${kernelMessage(e)}` })
        }
        for (const c of b.components) {
          try {
            const top = c.side === 'top'
            const z0 = top ? b.z + b.thickness : b.z - c.height
            const solid = (polyDrawing(c.courtyard).sketchOnPlane('XY', z0) as R.Sketch).extrude(c.height) as Shape3D
            this.cache.set(PART_PREFIX + c.ref, { key, shape: solid, status: this.describe({ name: PART_PREFIX + c.ref, type: 'extrude' } as Feature, solid, []) })
          } catch {
            // A degenerate courtyard only costs the 3D block.
          }
        }
      }
    }
    for (const n of [BOARD, ...b.components.map((c) => PART_PREFIX + c.ref)]) {
      const c = this.cache.get(n)
      if (c) {
        result.features.push(c.status)
        result.bodies.push(n)
      }
    }
  }

  private zoneCache: { key: string; fills: ZoneFill[] } | undefined

  boardState(doc: Doc, opts?: { drc?: boolean }): BoardState | undefined {
    if (!doc.pcb || !this.board) return undefined
    const key = JSON.stringify([doc.pcb.zones, doc.pcb.tracks, doc.pcb.vias, this.boardKey, doc.pcb.nets, doc.pcb.classes])
    if (this.zoneCache?.key !== key) this.zoneCache = { key, fills: fillZones(doc.pcb, this.board) }
    const zones = this.zoneCache.fills
    return {
      board: this.board,
      zones,
      ratsnest: ratsnest(doc.pcb, this.board, zones),
      drc: opts?.drc ? drc(doc.pcb, this.board, zones) : undefined,
    }
  }

  private drop(name: string) {
    const c = this.cache.get(name)
    if (c) {
      c.shape.delete()
      this.cache.delete(name)
    }
  }

  /** Parameter values a feature uses (cheap approximation: all of them). */
  private usedParams(_f: Feature): Record<string, number> {
    return Object.fromEntries(this.params)
  }

  /** A fresh copy of a built feature; the caller owns it. */
  shape(name: string): Shape3D {
    const c = this.cache.get(name)
    if (!c) {
      const known = [...this.cache.keys()]
      throw new Error(`no feature "${name}"${known.length ? `; features are: ${known.join(', ')}` : ' (the model is empty)'}`)
    }
    return c.shape.clone() as Shape3D
  }

  has(name: string): boolean {
    return this.cache.has(name)
  }

  private make(f: Feature, warnings: string[]): Shape3D {
    const p = this.params
    const n = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, p, `${f.name}.${field}`, fb)

    switch (f.type) {
      case 'box': {
        const [x, y, z] = vec(f.size, p, `${f.name}.size`)
        if (x <= 0 || y <= 0 || z <= 0) throw new Error(`size must be > 0 on every axis (got ${x} × ${y} × ${z})`)
        const c = f.center === undefined ? [true, true, false] : typeof f.center === 'boolean' ? [f.center, f.center, f.center] : f.center
        // makeBaseBox is centered on X/Y and sits on Z=0.
        let s: Shape3D = R.makeBaseBox(x, y, z)
        const dx = c[0] ? 0 : x / 2
        const dy = c[1] ? 0 : y / 2
        const dz = c[2] ? -z / 2 : 0
        if (dx || dy || dz) s = s.translate(dx, dy, dz)
        return place(s, f, p, f.name)
      }
      case 'cylinder': {
        const r = n(f.r, 'r')
        const h = n(f.h, 'h')
        if (r <= 0 || h <= 0) throw new Error(`r and h must be > 0 (got r=${r}, h=${h})`)
        const dir = AXES[f.axis ?? 'Z']
        return place(R.makeCylinder(r, h, [0, 0, 0], dir), f, p, f.name)
      }
      case 'sphere': {
        const r = n(f.r, 'r')
        if (r <= 0) throw new Error(`r must be > 0`)
        return place(R.makeSphere(r), f, p, f.name)
      }
      case 'extrude': {
        const { drawing, plane, offset } = this.outline(f)
        const dist = n(f.distance, 'distance')
        if (!dist) throw new Error('distance must not be 0')
        const flip = plane === 'XZ' ? -1 : 1
        const sk = onPlane(drawing, plane, f.symmetric ? offset - dist / 2 : offset)
        const solid = sk.extrude(dist * flip) as Shape3D
        return place(solid, f, p, f.name)
      }
      case 'revolve': {
        const { drawing, plane, offset } = this.outline(f)
        const angle = n(f.angle, 'angle', 360)
        if (angle <= 0 || angle > 360) throw new Error('angle must be in (0, 360]')
        const axis = f.axis
        const [u, v] = PLANE_AXES[plane]
        if (axis !== u && axis !== v) {
          throw new Error(`axis ${axis} is not in the ${plane} plane; revolve about ${u} or ${v} (an axis through the origin lying in the sketch plane)`)
        }
        const dir = AXES[axis]
        const sk = onPlane(drawing, plane, offset)
        const solid = (sk as R.Sketch).revolve(dir, { origin: [0, 0, 0], angle }) as Shape3D
        return place(solid, f, p, f.name)
      }
      case 'loft': {
        if (f.sections.length < 2) throw new Error('a loft needs at least 2 sections')
        const sketches = f.sections.map((sec, i) => {
          const what = `${f.name}.sections[${i}]`
          const { drawing, plane, offset } = this.outline({ ...sec, name: what })
          const sk = onPlane(drawing, plane, offset)
          if (!(sk instanceof R.Sketch)) {
            throw new Error(`${what} must be one closed outline without holes (loft joins single loops); loft the outer shape and cut the hole afterwards`)
          }
          return sk
        })
        const solid = sketches[0].loftWith(sketches.slice(1), { ruled: !!f.ruled }) as Shape3D
        return place(solid, f, p, f.name)
      }
      case 'sweep': {
        const pts = f.path.map((q, i) => vec(q, p, `${f.name}.path[${i}]`))
        if (pts.length < 2) throw new Error('path needs at least 2 points')
        const bend = n(f.bend, 'bend', 0)
        if (bend < 0) throw new Error('bend must be ≥ 0')
        const spine = pathWire(pts, bend, f.name)
        let drawing: R.Drawing
        if (f.sketch) {
          if (f.profile) throw new Error('use either sketch or profile, not both')
          drawing = sketchDrawing(this.sketch(f.sketch), f.name)
        } else if (f.profile) drawing = profileDrawing(f.profile, p, f.name)
        else throw new Error('needs a profile (rect, circle, slot, polygon) or a sketch for the cross-section')
        const t = norm3(sub3(pts[1], pts[0]))
        const up: V3 = Math.abs(t[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1]
        const xDir = norm3(cross3(up, t))
        const sk = drawing.sketchOnPlane(new R.Plane(pts[0], xDir, t))
        if (!(sk instanceof R.Sketch)) {
          throw new Error('the cross-section must be one closed outline without holes; for a tube sweep the inner profile too and cut it')
        }
        const solid = R.genericSweep(sk.wire, spine, { transitionMode: 'right', forceProfileSpineOthogonality: true }) as Shape3D
        return place(solid, f, p, f.name)
      }
      case 'boolean': {
        let s = this.shape(f.target)
        if (!f.tools.length) throw new Error('tools must name at least one feature')
        const before = volumeOf(s)
        for (const t of f.tools) {
          const tool = this.shape(t)
          if (f.op === 'union') {
            const touching = safeDistance(s, tool) <= 1e-6
            if (!touching) warnings.push(`"${t}" does not touch "${f.target}": the union holds separate solids`)
            s = s.fuse(tool)
          } else if (f.op === 'cut') {
            const v0 = volumeOf(s)
            s = s.cut(tool)
            if (Math.abs(volumeOf(s) - v0) < 1e-6) warnings.push(`cutting "${t}" removed no material: it does not overlap "${f.target}"`)
          } else {
            s = s.intersect(tool) as Shape3D
          }
        }
        if (f.op === 'intersect' && volumeOf(s) < 1e-9) warnings.push('the intersection is empty')
        if (f.op === 'union' && before > 0 && Math.abs(volumeOf(s) - before) < 1e-6) warnings.push('the union added no material')
        return s
      }
      case 'fillet':
      case 'chamfer': {
        const s = this.shape(f.target)
        const size = f.type === 'fillet' ? n(f.r, 'r') : n(f.d, 'd')
        if (size <= 0) throw new Error(`${f.type === 'fillet' ? 'r' : 'd'} must be > 0`)
        const edges = selectElements(s, f.edges, false, p, `${f.name}.edges`) as Edge[]
        if (!edges.length) throw new Error(`the edges selector matched no edge of "${f.target}" (it has ${s.edges.length}); try list_edges to see them`)
        const out =
          f.type === 'fillet'
            ? s.fillet(size, finderOf<EdgeFinder>(edges))
            : s.chamfer(size, finderOf<EdgeFinder>(edges))
        return out
      }
      case 'shell': {
        const s = this.shape(f.target)
        const t = n(f.thickness, 'thickness')
        if (t <= 0) throw new Error('thickness must be > 0')
        const open = selectElements(s, f.open ?? { where: '>Z' }, true, p, `${f.name}.open`) as Face[]
        if (!open.length) throw new Error(`the open selector matched no face of "${f.target}"; try list_faces`)
        return s.shell(t, finderOf<FaceFinder>(open))
      }
      case 'transform':
        return place(this.shape(f.target), f, p, f.name)
      case 'pattern': {
        const base = this.shape(f.target)
        const offsets: V3[] = []
        if (f.kind === 'linear') {
          const count = Math.round(n(f.count, 'count'))
          if (count < 1 || count > 500) throw new Error('count must be between 1 and 500')
          const step = vec(f.step, p, `${f.name}.step`)
          for (let i = 0; i < count; i++) offsets.push([step[0] * i, step[1] * i, step[2] * i])
        } else {
          const cx = Math.round(num(f.count[0], p, `${f.name}.count[0]`))
          const cy = Math.round(num(f.count[1], p, `${f.name}.count[1]`))
          if (cx < 1 || cy < 1 || cx * cy > 2000) throw new Error('count must be ≥ 1 per axis and at most 2000 in total')
          const sx = num(f.step[0], p, `${f.name}.step[0]`)
          const sy = num(f.step[1], p, `${f.name}.step[1]`)
          for (let i = 0; i < cx; i++) for (let j = 0; j < cy; j++) offsets.push([sx * i, sy * j, 0])
        }
        let out: Shape3D | undefined
        for (const [x, y, z] of offsets) {
          const copy = (base.clone() as Shape3D).translate(x, y, z)
          out = out ? out.fuse(copy) : copy
        }
        base.delete()
        return out!
      }
    }
  }

  private hint(f: Feature, e: unknown): string {
    if (e instanceof Error && e.message && !(e instanceof WebAssembly.Exception)) return ''
    switch (f.type) {
      case 'fillet':
      case 'chamfer':
        return '. Usually the size is too large for the selected edges (keep it below half the thinnest adjacent wall), or the selector picks edges that cannot be rounded together. Try a smaller value, or select fewer edges (list_edges shows them).'
      case 'shell':
        return '. Usually the thickness is larger than a wall, a fillet radius or a small feature of the solid. Shell before filleting, or use a smaller thickness.'
      case 'boolean':
        return '. The tools may touch the target only on a face or an edge; overlap them a little (e.g. 0.01 mm) or move them apart.'
      default:
        return ''
    }
  }

  private describe(f: Feature, s: Shape3D, warnings: string[]): FeatureStatus {
    const st: FeatureStatus = { name: f.name, type: f.type, ok: true }
    try {
      st.bbox = bboxOf(s)
      st.volume = round(volumeOf(s), 3)
      st.solids = s.solids?.length ?? 1
      st.faces = s.faces.length
      st.edges = s.edges.length
    } catch {
      // A shape without a bounding box is still valid (empty intersect).
    }
    if ((st.solids ?? 1) > 1 && f.type !== 'pattern') warnings.push(`the result has ${st.solids} separate solids`)
    if (st.volume !== undefined && st.volume <= 0) warnings.push('the result has no volume')
    if (warnings.length) st.warnings = warnings
    return st
  }

  /**
   * Solved sketches as 3D polylines for display: each entity becomes a run
   * of points on its plane.
   */
  sketchLines(doc: Doc): SketchLines[] {
    const out: SketchLines[] = []
    for (const s of doc.sketches) {
      let sk: SolvedSketch
      try {
        sk = this.sketch(s.name)
      } catch {
        continue
      }
      const off = (() => {
        try {
          return num(s.offset, this.params, 'offset', 0)
        } catch {
          return 0
        }
      })()
      const to3 = (u: number, v: number): V3 => (s.plane === 'XY' ? [u, v, off] : s.plane === 'XZ' ? [u, off, v] : [off, u, v])
      const lines: number[] = []
      const construction: number[] = []
      const seg = (dst: number[], a: V3, b: V3) => dst.push(...a, ...b)
      for (const e of sk.entities) {
        const dst = e.construction ? construction : lines
        if (e.kind === 'line') seg(dst, to3(...e.a), to3(...e.b))
        else {
          const [a0, a1] =
            e.kind === 'circle'
              ? [0, 2 * Math.PI]
              : (() => {
                  const s0 = Math.atan2(e.start[1] - e.c[1], e.start[0] - e.c[0])
                  let s1 = Math.atan2(e.end[1] - e.c[1], e.end[0] - e.c[0])
                  if (s1 <= s0) s1 += 2 * Math.PI
                  return [s0, s1]
                })()
          const n = Math.max(8, Math.ceil(((a1 - a0) / (2 * Math.PI)) * 64))
          for (let i = 0; i < n; i++) {
            const t0 = a0 + ((a1 - a0) * i) / n
            const t1 = a0 + ((a1 - a0) * (i + 1)) / n
            seg(dst, to3(e.c[0] + e.r * Math.cos(t0), e.c[1] + e.r * Math.sin(t0)), to3(e.c[0] + e.r * Math.cos(t1), e.c[1] + e.r * Math.sin(t1)))
          }
        }
      }
      const used = doc.features.some((f) => sketchesOf(f).includes(s.name))
      out.push({ name: s.name, ok: sk.ok, dof: sk.dof, used, lines: new Float32Array(lines), construction: new Float32Array(construction) })
    }
    return out
  }

  /** Triangle meshes of the visible bodies; unchanged bodies are reused. */
  meshes(result: BuildResult, tolerance = 0.05): MeshData[] {
    const out: MeshData[] = []
    const live = new Set<string>()
    for (const name of result.bodies) {
      const c = this.cache.get(name)
      if (!c) continue
      const key = c.key + '#' + name
      live.add(key)
      let m = this.meshCache.get(key)
      if (!m) {
        const mesh = c.shape.mesh({ tolerance, angularTolerance: 0.2 })
        const edges = c.shape.meshEdges({ tolerance, angularTolerance: 0.2 })
        const egroups = new Uint32Array(edges.edgeGroups.length * 2)
        edges.edgeGroups.forEach((g, i) => {
          egroups[i * 2] = g.start
          egroups[i * 2 + 1] = g.count
        })
        const groups = new Uint32Array(mesh.faceGroups.length * 2)
        mesh.faceGroups.forEach((g, i) => {
          groups[i * 2] = g.start
          groups[i * 2 + 1] = g.count
        })
        m = {
          name,
          key,
          vertices: new Float32Array(mesh.vertices),
          normals: new Float32Array(mesh.normals),
          triangles: new Uint32Array(mesh.triangles),
          edges: new Float32Array(edges.lines),
          edgeGroups: egroups,
          faceGroups: groups,
        }
        this.meshCache.set(key, m)
      }
      const f = this.doc?.features.find((x) => x.name === name)
      const color = f?.color ?? (name === BOARD ? '#2f6f3e' : name.startsWith(PART_PREFIX) ? '#30343b' : undefined)
      out.push({ ...m, name, color, opacity: f?.opacity })
    }
    for (const k of [...this.meshCache.keys()]) if (!live.has(k)) this.meshCache.delete(k)
    return out
  }

  faces(name: string, sel?: Selector): FaceInfo[] {
    const s = this.shape(name)
    try {
      const { all, picked } = selectIndexed(s, sel, true, this.params)
      return picked.map((i) => {
        const f = all[i] as Face
        return {
        index: i,
        type: friendlyType(f.geomType),
        center: r3(centerOf(f)),
        normal: (() => {
          const d = directionOf(f, true)
          return d ? r3(d) : undefined
        })(),
        area: round(R.measureArea(f), 3),
        }
      })
    } finally {
      s.delete()
    }
  }

  edges(name: string, sel?: Selector): EdgeInfo[] {
    const s = this.shape(name)
    try {
      const { all, picked } = selectIndexed(s, sel, false, this.params)
      return picked.map((i) => {
        const e = all[i] as Edge
        return {
          index: i,
          type: friendlyType(e.geomType),
          start: r3(e.startPoint.toTuple() as V3),
          end: r3(e.endPoint.toTuple() as V3),
          length: round(e.length, 3),
        }
      })
    } finally {
      s.delete()
    }
  }

  measure(a: string, b?: string): Record<string, unknown> {
    const sa = this.shape(a)
    try {
      const out: Record<string, unknown> = {
        name: a,
        bbox: bboxOf(sa),
        size: (() => {
          const [lo, hi] = bboxOf(sa)
          return r3([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]])
        })(),
        volume: round(volumeOf(sa), 3),
        area: round(R.measureArea(sa), 3),
      }
      try {
        const props = R.measureShapeVolumeProperties(sa)
        out.center_of_mass = r3(props.centerOfMass as V3)
      } catch {
        // not a solid
      }
      if (b) {
        const sb = this.shape(b)
        try {
          out.other = b
          out.distance = round(safeDistance(sa, sb), 4)
          out.overlap_volume = round(overlapVolume(sa, sb), 4)
        } finally {
          sb.delete()
        }
      }
      return out
    } finally {
      sa.delete()
    }
  }

  /**
   * Distance between two things, each a feature name or a point [x, y, z]:
   * the minimum distance, and for two points the vector between them.
   */
  between(a: string | V3, b: string | V3): Record<string, unknown> {
    const isPt = (v: string | V3): v is V3 => Array.isArray(v)
    if (isPt(a) && isPt(b)) {
      const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      return { distance: round(Math.hypot(...d), 4), delta: r3(d), from: a, to: b }
    }
    const shape = (v: string | V3) => (isPt(v) ? (R.makeSphere(1e-4).translate(v[0], v[1], v[2]) as Shape3D) : this.shape(v))
    const sa = shape(a)
    const sb = shape(b)
    try {
      const out: Record<string, unknown> = { a, b, distance: round(Math.max(0, safeDistance(sa, sb) - (isPt(a) || isPt(b) ? 1e-4 : 0)), 4) }
      if (!isPt(a) && !isPt(b)) out.overlap_volume = round(overlapVolume(sa, sb), 4)
      if (out.distance === 0 && (isPt(a) || isPt(b))) out.note = 'the point is on or inside the feature'
      return out
    } finally {
      sa.delete()
      sb.delete()
    }
  }

  checks(doc: Doc): CheckResult[] {
    const p = this.params
    return doc.checks.map((c): CheckResult => {
      const base = { name: c.name, kind: c.kind, note: c.note }
      try {
        switch (c.kind) {
          case 'expr': {
            const v = num(c.expr, p, `check ${c.name}`)
            return { ...base, ok: v !== 0, detail: v !== 0 ? `${c.expr} holds` : `${c.expr} is false` }
          }
          case 'min_distance': {
            const min = num(c.min, p, `check ${c.name}.min`)
            const [sa, sb] = [this.shape(c.a), this.shape(c.b)]
            const d = safeDistance(sa, sb)
            sa.delete()
            sb.delete()
            return { ...base, ok: d >= min - 1e-6, detail: `distance ${c.a}↔${c.b} = ${d.toFixed(3)} mm (min ${min})` }
          }
          case 'no_overlap': {
            const [sa, sb] = [this.shape(c.a), this.shape(c.b)]
            const v = overlapVolume(sa, sb)
            sa.delete()
            sb.delete()
            return { ...base, ok: v < 1e-6, detail: v < 1e-6 ? `${c.a} and ${c.b} do not overlap` : `${c.a} and ${c.b} overlap by ${v.toFixed(3)} mm³` }
          }
          case 'inside': {
            // inner must lie fully within outer (a body that stands for the
            // free space, e.g. a cavity), keeping margin to every side of
            // outer's bounding box.
            const margin = num(c.margin, p, `check ${c.name}.margin`, 0)
            const [si, so] = [this.shape(c.inner), this.shape(c.outer)]
            const [ilo, ihi] = bboxOf(si)
            const [olo, ohi] = bboxOf(so)
            const vi = volumeOf(si)
            const within = overlapVolume(si, so)
            si.delete()
            so.delete()
            const outside = Math.max(0, vi - within)
            const gaps = [0, 1, 2].flatMap((i) => [ilo[i] - olo[i], ohi[i] - ihi[i]])
            const minGap = Math.min(...gaps)
            const ok = minGap >= margin - 1e-6 && outside < 1e-6
            const axis = ['-X', '+X', '-Y', '+Y', '-Z', '+Z'][gaps.indexOf(minGap)]
            return {
              ...base,
              ok,
              detail:
                (outside >= 1e-6 ? `${outside.toFixed(3)} mm³ of ${c.inner} is outside ${c.outer}; ` : '') +
                `smallest gap ${minGap.toFixed(3)} mm on ${axis} (margin ${margin})`,
            }
          }
          case 'volume': {
            const s = this.shape(c.target)
            const v = volumeOf(s)
            s.delete()
            const min = c.min !== undefined ? num(c.min, p, `check ${c.name}.min`) : -Infinity
            const max = c.max !== undefined ? num(c.max, p, `check ${c.name}.max`) : Infinity
            return { ...base, ok: v >= min && v <= max, detail: `volume ${v.toFixed(2)} mm³` }
          }
        }
      } catch (e) {
        return { ...base, ok: false, detail: `cannot evaluate: ${kernelMessage(e)}` }
      }
      return { ...base, ok: false, detail: 'unknown check kind' }
    })
  }

  /**
   * STEP or STL of the named features (default: all bodies) in one file.
   * models replaces part_* blocks with the vendor meshes (OBJ text by
   * part ref), sewn into faces.
   */
  export(format: 'step' | 'stl', names: string[], models: Record<string, string> = {}): Blob {
    if (!names.length) throw new Error('nothing to export: the model has no bodies')
    const shapes = names.map((n) => {
      const ref = n.startsWith(PART_PREFIX) ? n.slice(PART_PREFIX.length) : undefined
      const obj = ref ? models[ref] : undefined
      const c = ref ? this.board?.components.find((x) => x.ref === ref) : undefined
      if (obj && c?.footprint.model && this.board) {
        try {
          return meshShape(obj, c.footprint.model, c, this.board)
        } catch {
          // fall back to the block
        }
      }
      return this.shape(n)
    })
    const compound = shapes.length === 1 ? shapes[0] : (R.makeCompound(shapes) as Shape3D)
    try {
      return format === 'step' ? compound.blobSTEP() : compound.blobSTL({ binary: true })
    } finally {
      compound.delete()
    }
  }

  get parameters(): Map<string, number> {
    return this.params
  }
}

/** A vendor mesh placed on the board, as sewn triangle faces. */
function meshShape(obj: string, model: Model3D, c: ResolvedBoard['components'][number], b: ResolvedBoard): Shape3D {
  const placed = placeModel(parseOBJ(obj), model)
  const oc = R.getOC()
  const sew = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false)
  const rad = (c.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const bottom = c.side === 'bottom'
  const z0 = bottom ? b.z : b.z + b.thickness
  const tr = (x: number, y: number, z: number): [number, number, number] => {
    if (bottom) {
      x = -x
      z = -z
    }
    return [c.at.x + x * cos - y * sin, c.at.y + x * sin + y * cos, z0 + z]
  }
  let n = 0
  for (const g of placed.groups) {
    const p = g.positions
    for (let i = 0; i + 8 < p.length; i += 9) {
      try {
        const f = R.makePolygon([tr(p[i], p[i + 1], p[i + 2]), tr(p[i + 3], p[i + 4], p[i + 5]), tr(p[i + 6], p[i + 7], p[i + 8])])
        sew.Add(f.wrapped)
        f.delete()
        n++
      } catch {
        // degenerate triangle
      }
    }
  }
  if (!n) {
    sew.delete()
    throw new Error('empty model')
  }
  const progress = new oc.Message_ProgressRange()
  sew.Perform(progress)
  const shape = R.cast(sew.SewedShape()) as Shape3D
  progress.delete()
  sew.delete()
  return shape
}

function safeDistance(a: Shape3D, b: Shape3D): number {
  try {
    return R.measureDistanceBetween(a, b)
  } catch {
    return Infinity
  }
}

function overlapVolume(a: Shape3D, b: Shape3D): number {
  try {
    const i = (a.clone() as Shape3D).intersect(b.clone() as Shape3D) as Shape3D
    const v = volumeOf(i)
    i.delete()
    return v
  } catch {
    return 0
  }
}
