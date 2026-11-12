// The kernel turns a Doc into solids with OpenCascade (through replicad).
// It runs in a Web Worker in the browser and directly in Node for tests.
//
// Every feature is rebuilt only when its resolved definition or one of its
// inputs changed. replicad operations consume their inputs, so the cache
// keeps a master copy of each shape and every use works on a clone.

import RAPIER from '@dimforge/rapier3d-compat'
import * as R from 'replicad'
import type { AnyShape, Edge, EdgeFinder, Face, FaceFinder, Shape3D } from 'replicad'

import { type Check, type Decal, type Doc, type Expr, type Feature, type Material, type Model3D, type Plane, type Profile, type Selector, type Sketch, type Track, type Vec3E, type Via, bodies, dependsOn, inputsOf, sketchesOf } from './doc'
import { namesIn, num, resolveParameters } from './expr'
import { explodeOffset } from './explode'
import { fontMetrics } from './fonts'
import { boardStyle } from './pcb/artwork'
import { boardDrills } from './pcb/drills'
import { type GearState, GearError, describeGear, gearLocalShape, gearOptions, gearStates, localKey, placeGear } from './gears'
import { type MotionPlan, motionPlan } from './motion'
import { type Mechanisms, mechanismReport, mechanismShape, mechanismStates } from './mechanisms'
import { createWorld, drivenPose, initPhysics, rotate } from './physics'

function meshCenter(m: { vertices: Float32Array }): [number, number, number] {
  let x = 0
  let y = 0
  let z = 0
  const n = m.vertices.length / 3
  for (let i = 0; i < n; i++) {
    x += m.vertices[i * 3]
    y += m.vertices[i * 3 + 1]
    z += m.vertices[i * 3 + 2]
  }
  return [x / n, y / n, z / n]
}
import { autorouteBoard } from './pcb/autoroute'
import { type ResolvedBoard, resolveBoard } from './pcb/board'
import type { AutorouteOptions, AutorouteResult } from './registry'
import { drc, ratsnest } from './pcb/drc'
import { parseOBJ, placeModel } from './pcb/model3d'
import { type ZoneFill, fillZones } from './pcb/zones'
import type { BoardState } from './pcb/state'
import { type Loop, type SolvedSketch, loopInside, solveSketch } from './sketch'
import { MeshBody, composeBodies, displayMesh, meshBody, meshCube, meshFromTriangles } from './mesh-body'
import { type ThreeMF, type TriMesh, isZip, parseSTL, pickObject, read3MF, update3MF, write3MF, writeSTL } from './model-files'

/** A built feature: an OpenCascade solid, or a triangle-mesh solid (imported STL / 3MF and what is built from it). */
export type Body = Shape3D | MeshBody

const isMesh = (b: Body): b is MeshBody => b instanceof MeshBody

/** STL files up to this size also become OpenCascade solids (faces to select, part models). */
const SOLID_STL_TRIANGLES = 20_000

/** A downloaded model file, by URL (with #fragment). */
type Loaded = { shape: Shape3D } | { tri: TriMesh; solid?: Shape3D | Error; mesh?: MeshBody }

/** Where a URL is fetched from: a 3MF file once for all its #objects. */
export function fetchKey(url: string): string {
  const [base] = url.split('#')
  return /\.3mf$/i.test(base) ? base : url
}

/** The triangles of a B-rep solid as a mesh body (fine tessellation: booleans with meshes, mesh checks). */
function brepToMesh(s: Shape3D, what: string): MeshBody {
  const m = s.mesh({ tolerance: 0.01, angularTolerance: 0.1 })
  return meshFromTriangles(m.vertices, m.triangles, what)
}

function bodyBox(b: Body): BBox {
  if (isMesh(b)) {
    const [lo, hi] = b.bbox()
    return [r3(lo), r3(hi)]
  }
  return bboxOf(b)
}

function bodyVolume(b: Body): number {
  return isMesh(b) ? b.volume() : volumeOf(b)
}

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
  /** Build time when slow (≥ 300 ms). */
  ms?: number
  faces?: number
  edges?: number
  /** A triangle-mesh body (imported STL / 3MF): its triangle count. It has no faces or edges to select. */
  triangles?: number
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
  /** Problems with materials or decals (display only, never fail the build). */
  appearance?: string[]
  /** Where the last build spent its time, ms (worker): imports, build, mesh, board. */
  timing?: Record<string, number>
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
  /** The feature's material (display only). */
  material?: Material
  /** Decals projected onto this body, with numbers resolved. */
  decals?: ResolvedDecal[]
  /** Exploded-view offset (display only). */
  explode?: V3
}

export interface ResolvedDecal extends Omit<Decal, 'at' | 'size' | 'depth' | 'rotation' | 'font_size'> {
  at: V3
  size: [number, number]
  depth: number
  rotation: number
  font_size?: number
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
  /** Time it took when slow (≥ 200 ms). */
  ms?: number
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

/** Number of distinct faces or edges, without building wrapper objects for each. */
function countTopo(s: AnyShape, kind: 'face' | 'edge'): number {
  let n = 0
  for (const e of R.iterTopo(s.wrapped, kind)) {
    n++
    ;(e as { delete?: () => void }).delete?.()
  }
  return n
}

/** Boxes of big shapes, by the TopoDS_Shape they wrap (cleared when shapes are rebuilt). */
const bigBoxes = new WeakMap<object, BBox>()

/** Faces met by a topology walk, stopping after limit (no dedupe, no wrappers: fast). */
function faceCount(s: AnyShape, limit = Infinity): number {
  const oc = R.getOC()
  let n = 0
  const ex = new oc.TopExp_Explorer(s.wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)
  for (; ex.More() && n <= limit; ex.Next()) n++
  ex.delete()
  return n
}

function bboxOf(s: AnyShape): BBox {
  const hit = bigBoxes.get(s.wrapped)
  if (hit) return hit
  // The exact box (AddOptimal) walks every surface: seconds for a vendor
  // STEP model. The box from its triangulation is as good for checks.
  const oc = R.getOC()
  if (faceCount(s, 200) > 200) {
    const box = new oc.Bnd_Box()
    oc.BRepBndLib.Add(s.wrapped, box, true)
    const lo = box.CornerMin()
    const hi = box.CornerMax()
    const out: BBox = [r3([lo.X(), lo.Y(), lo.Z()]), r3([hi.X(), hi.Y(), hi.Z()])]
    lo.delete()
    hi.delete()
    box.delete()
    bigBoxes.set(s.wrapped, out)
    return out
  }
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
  const [tx, ty, tz] = vec(f.translate, params, `${what}.translate`)
  if (!rx && !ry && !rz && !tx && !ty && !tz) return s
  // Big shapes (vendor STEP models with hundreds of faces): move them by
  // location, one transform and no copy of the geometry, instead of a copy
  // per rotate and translate.
  if (faceCount(s, 200) > 200) return moveByLocation(s, [rx, ry, rz], [tx, ty, tz])
  if (rx) s = s.rotate(rx, [0, 0, 0], [1, 0, 0])
  if (ry) s = s.rotate(ry, [0, 0, 0], [0, 1, 0])
  if (rz) s = s.rotate(rz, [0, 0, 0], [0, 0, 1])
  if (tx || ty || tz) s = s.translate(tx, ty, tz)
  return s
}

/** Rotates (X, then Y, then Z, degrees, about the origin) and translates a shape by changing its location only. */
function moveByLocation(s: Shape3D, r: V3, t: V3): Shape3D {
  const oc = R.getOC()
  const total = new oc.gp_Trsf()
  const step = (fn: (tr: InstanceType<typeof oc.gp_Trsf>) => void) => {
    const tr = new oc.gp_Trsf()
    fn(tr)
    // total = tr ∘ total (apply tr after what came before)
    total.PreMultiply(tr)
    tr.delete()
  }
  const axes: V3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  for (let i = 0; i < 3; i++) {
    if (!r[i]) continue
    step((tr) => {
      const o = new oc.gp_Pnt(0, 0, 0)
      const d = new oc.gp_Dir(axes[i][0], axes[i][1], axes[i][2])
      const ax = new oc.gp_Ax1(o, d)
      tr.SetRotation(ax, (r[i] * Math.PI) / 180)
      ax.delete()
      d.delete()
      o.delete()
    })
  }
  if (t[0] || t[1] || t[2])
    step((tr) => {
      const v = new oc.gp_Vec(t[0], t[1], t[2])
      tr.SetTranslation(v)
      v.delete()
    })
  const loc = new oc.TopLoc_Location(total)
  const moved = R.cast(s.wrapped.Moved(loc, false)) as Shape3D
  loc.delete()
  total.delete()
  s.delete()
  return moved
}

/** A 2D outline from a profile (rect, circle, slot, polygon). */
function resolveDecal(d: Decal, params: Map<string, number>): ResolvedDecal {
  const w = `decal ${d.name}`
  const at = vec(d.at, params, `${w}.at`)
  const size: [number, number] = [num(d.size[0], params, `${w}.size[0]`), num(d.size[1], params, `${w}.size[1]`)]
  if (size[0] <= 0 || size[1] <= 0) throw new Error(`size must be > 0 (got ${size[0]} × ${size[1]})`)
  if (!d.text && !d.image) throw new Error('needs text or image')
  const len = Math.hypot(...d.normal)
  if (len < 1e-9) throw new Error('normal must not be [0, 0, 0]')
  const { at: _a, size: _s, depth, rotation, font_size, ...rest } = d
  return {
    ...rest,
    at,
    size,
    depth: num(depth, params, `${w}.depth`, 2),
    rotation: num(rotation, params, `${w}.rotation`, 0),
    ...(font_size !== undefined ? { font_size: num(font_size, params, `${w}.font_size`) } : {}),
  }
}

/** A 2D outline from a profile (rect, circle, slot, polygon). */
function profileDrawing(p: NonNullable<Extract<Feature, { type: 'extrude' }>['profile']>, params: Map<string, number>, what: string): R.Drawing {
  const d = baseProfileDrawing(p, params, what)
  const off = num((p as { inset?: Expr }).inset, params, `${what}.profile.inset`, 0)
  if (!off) return d
  // inset > 0 shrinks the outline (walls, lips, clearances from one outline); < 0 grows it. Sharp corners stay sharp.
  try {
    // The offset sign follows the outline's winding: take the one that shrinks for inset > 0.
    const a = d.offset(-off, { lineJoinType: 'miter' })
    const b = d.offset(off, { lineJoinType: 'miter' })
    const size = (x: R.Drawing) => {
      const [[x0, y0], [x1, y1]] = x.boundingBox.bounds
      return (x1 - x0) * (y1 - y0)
    }
    return off > 0 === size(a) < size(b) ? a : b
  } catch (e) {
    throw new Error(`${what}: cannot inset the profile by ${off} mm (${kernelMessage(e)}); a narrow part of the outline may vanish, use a smaller inset`)
  }
}

function baseProfileDrawing(p: NonNullable<Extract<Feature, { type: 'extrude' }>['profile']>, params: Map<string, number>, what: string): R.Drawing {
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
  shape: Body
  status: FeatureStatus
  /** The B-rep solid as a mesh body, made once when a mesh operation or check needs it. */
  meshed?: MeshBody
}

export class Kernel {
  private cache = new Map<string, CacheEntry>()
  private meshCache = new Map<string, MeshData>()
  private params = new Map<string, number>()
  private doc: Doc | undefined
  /** STEP/STL/3MF files by URL, read before a build (import features). */
  private imported = new Map<string, Loaded | Error>()
  /** Opened 3MF files by fetch URL: each #object is read from it on demand. */
  private threeMF = new Map<string, ThreeMF | Error>()

  /** URLs to fetch before building doc: 3MF files once, whatever objects are taken from them. */
  missingImports(doc: Doc): string[] {
    const urls = [...doc.features.flatMap((f) => (f.type === 'import' ? [f.url] : [])), ...(doc.pcb?.components ?? []).flatMap((c) => (c.model ? [c.model.url] : []))]
    const want = urls.filter((u) => !this.imported.has(u) && !this.threeMF.has(fetchKey(u)))
    return [...new Set(want.map(fetchKey))]
  }

  /**
   * Reads a downloaded STEP, STL or 3MF file for the import features with
   * this URL. A 3MF URL (without #) opens the file: its objects are read
   * when a feature asks for them by #id or #name.
   */
  async loadImport(url: string, data: ArrayBuffer | Error): Promise<void> {
    if (data instanceof Error) {
      if (fetchKey(url) !== url || /\.3mf$/i.test(url)) this.threeMF.set(fetchKey(url), data)
      else this.imported.set(url, data)
      return
    }
    try {
      if (isZip(data) && /\.3mf$/i.test(url.split('#')[0])) {
        this.threeMF.set(fetchKey(url), await read3MF(data))
        return
      }
      const head = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(512, data.byteLength)))
      if (head.includes('ISO-10303-21')) {
        this.imported.set(url, { shape: (await R.importSTEP(new Blob([data]))) as Shape3D })
        return
      }
      const tri = parseSTL(data)
      const entry: Loaded = { tri }
      // A small STL also becomes a B-rep solid: faces to select, and it can be a board part model.
      if (tri.triangles.length / 3 <= SOLID_STL_TRIANGLES) {
        try {
          entry.solid = (await R.importSTL(new Blob([data]))) as Shape3D
        } catch (e) {
          entry.solid = new Error(kernelMessage(e))
        }
      }
      this.imported.set(url, entry)
    } catch (e) {
      this.imported.set(url, new Error(`could not read ${url}: ${kernelMessage(e)}`))
    }
  }

  /** Reads the #objects of opened 3MF files that doc uses (synchronous builds need them ready). */
  async prepareImports(doc: Doc): Promise<void> {
    const urls = new Set([...doc.features.flatMap((f) => (f.type === 'import' ? [f.url] : [])), ...(doc.pcb?.components ?? []).flatMap((c) => (c.model ? [c.model.url] : []))])
    for (const url of urls) {
      if (this.imported.has(url)) continue
      const file = this.threeMF.get(fetchKey(url))
      if (!file) continue
      if (file instanceof Error) {
        this.imported.set(url, file)
        continue
      }
      const name = decodeURIComponent(fetchKey(url).split('/').pop() ?? '3MF file')
      try {
        const obj = pickObject(file, decodeURIComponent(url.split('#')[1] ?? ''), name)
        this.imported.set(url, { tri: await file.mesh(obj.id) })
      } catch (e) {
        this.imported.set(url, new Error(kernelMessage(e)))
      }
    }
  }

  /** The loaded body of an import URL: a B-rep solid (STEP, small STL) unless mesh is preferred. */
  private importedBody(url: string, what: string, solidOnly = false): Body {
    const s = this.imported.get(url)
    if (!s) {
      if (this.threeMF.has(fetchKey(url))) throw new Error(`${url} is not read yet; build again`)
      throw new Error(`${url} is not loaded yet; it is downloaded before the build (check the URL and the server log)`)
    }
    if (s instanceof Error) throw s
    if ('shape' in s) return s.shape.clone() as Shape3D
    if (solidOnly) {
      if (s.solid instanceof Error) throw new Error(`${what}: OpenCascade cannot make a solid of this STL (${s.solid.message})`)
      if (!s.solid) throw new Error(`${what}: the model has ${s.tri.triangles.length / 3} triangles; a part model needs a STEP file or an STL with at most ${SOLID_STL_TRIANGLES} triangles`)
      return s.solid.clone() as Shape3D
    }
    if (s.solid && !(s.solid instanceof Error)) return s.solid.clone() as Shape3D
    s.mesh ??= meshBody(s.tri, what)
    return s.mesh.clone()
  }

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
    this.gears = doc.features.some((f) => f.type === 'gear') ? gearStates(doc, this.params) : new Map()
    this.mechanisms = mechanismStates(doc, this.params)

    const keys = new Map<string, string>()
    const seen = new Set<string>()

    for (const f of doc.features) {
      if (seen.has(f.name)) {
        result.ok = false
        result.features.push({ name: f.name, type: f.type, ok: false, error: `duplicate feature name "${f.name}"` })
        continue
      }
      seen.add(f.name)

      const inputs = dependsOn(f)
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
        // A gear's place depends on the gears it follows: key on its solved state.
        const gs = f.type === 'gear' ? this.gears.get(f.name) : undefined
        const gk = gs instanceof GearError ? gs.message : gs ? [gs.center, gs.frame, gs.rotation, gs.travel, gs.helix, gs.rp] : undefined
        // A geneva wheel is built from its drive's fields.
        const mk = f.type === 'geneva' && f.part === 'wheel' ? doc.features.find((x) => x.name === f.drive) : undefined
        key = JSON.stringify([f, this.usedParams(f), sk, gk, mk]) + '|' + inputs.map((i) => keys.get(i)).join('|')
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
      let shape: Body | undefined
      let status: FeatureStatus
      const t0 = Date.now()
      try {
        const warnings: string[] = []
        shape = this.make(f, warnings)
        status = this.describe(f, shape, warnings)
        const ms = Date.now() - t0
        // Slow features are worth knowing about (fillets on big bodies, imports).
        if (ms >= 300) status.ms = ms
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
    const appearance = this.appearanceStatus(doc)
    if (appearance.length) result.appearance = appearance

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
    const drills = boardDrills(doc.pcb, b)
    const key = JSON.stringify([
      b.outline,
      b.cutouts,
      b.thickness,
      b.z,
      b.holes,
      drills,
      b.components.map((c) => [c.ref, c.at, c.rotation, c.side, c.courtyard, c.height, c.model, c.model && this.imported.get(c.model.url) instanceof Error]),
      [...new Set(b.components.flatMap((c) => (c.model ? [c.model.url] : [])))].map((u) => this.imported.has(u)),
    ])
    if (key !== this.boardKey) {
      this.boardKey = key
      for (const n of [...this.cache.keys()]) if (n === BOARD || n.startsWith(PART_PREFIX)) this.drop(n)
      if (b.outline.length >= 3) {
        try {
          let d = polyDrawing(b.outline)
          for (const c of b.cutouts) d = d.cut(polyDrawing(c))
          for (const h of drills) {
            const length = Math.hypot(h.to.x - h.from.x, h.to.y - h.from.y)
            const hole = length < 1e-9 ? R.drawCircle(h.d / 2) : R.drawRoundedRectangle(length + h.d, h.d, h.d / 2 - 1e-6).rotate(Math.atan2(h.to.y - h.from.y, h.to.x - h.from.x) * 180 / Math.PI)
            d = d.cut(hole.translate((h.from.x + h.to.x) / 2, (h.from.y + h.to.y) / 2))
          }
          const solid = (d.sketchOnPlane('XY', b.z) as R.Sketch).extrude(b.thickness) as Shape3D
          this.cache.set(BOARD, { key, shape: solid, status: this.describe({ name: BOARD, type: 'extrude' } as Feature, solid, []) })
        } catch (e) {
          result.ok = false
          result.features.push({ name: BOARD, type: 'extrude', ok: false, error: `board: ${kernelMessage(e)}` })
        }
        for (const c of b.components) {
          const name = PART_PREFIX + c.ref
          if (c.model) {
            try {
              const solid = this.partModel(c, b)
              this.cache.set(name, { key, shape: solid, status: this.describe({ name, type: 'import' } as Feature, solid, []) })
              continue
            } catch (e) {
              result.ok = false
              result.features.push({ name, type: 'import', ok: false, error: `${c.ref} model: ${kernelMessage(e)}; the part shows as its courtyard block` })
            }
          }
          try {
            const top = c.side === 'top'
            const z0 = top ? b.z + b.thickness : b.z - c.height
            const solid = (polyDrawing(c.courtyard).sketchOnPlane('XY', z0) as R.Sketch).extrude(c.height) as Shape3D
            this.cache.set(name, { key, shape: solid, status: this.describe({ name, type: 'extrude' } as Feature, solid, []) })
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

  /**
   * A part's real model on the board: placed in footprint space (rotate,
   * translate, z up from the face the part sits on), then mirrored for the
   * bottom side, turned by the part rotation and moved to the part.
   */
  private partModel(c: ResolvedBoard['components'][number], b: ResolvedBoard): Shape3D {
    const m = c.model!
    let shape = this.importedBody(m.url, `${c.ref} model`, true) as Shape3D
    const k = num(m.scale, this.params, `${c.ref}.model.scale`, 1)
    if (k !== 1) shape = shape.scale(k, [0, 0, 0]) as Shape3D
    shape = place(shape, m, this.params, `${c.ref}.model`)
    if (c.side === 'bottom') shape = shape.mirror('XY', [0, 0, 0]).mirror('YZ', [0, 0, 0]) as Shape3D
    if (c.rotation) shape = shape.rotate(c.rotation, [0, 0, 0], [0, 0, 1])
    const z = c.side === 'bottom' ? b.z : b.z + b.thickness
    return shape.translate(c.at.x, c.at.y, z)
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
      c.meshed?.delete()
      this.cache.delete(name)
    }
  }

  /** Cache primitives against their actual resolved dimensions; keep the
   * conservative full key for features with indirect dependencies. */
  private usedParams(f: Feature): Record<string, number> {
    if (f.type !== 'box' && f.type !== 'cylinder' && f.type !== 'sphere') return Object.fromEntries(this.params)
    const expressions: unknown[] = [f.translate, f.rotate]
    if (f.type === 'box') expressions.push(f.size)
    else if (f.type === 'cylinder') expressions.push(f.r, f.h)
    else expressions.push(f.r)
    const names = new Set<string>()
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect)
      else if (typeof value === 'string') for (const name of namesIn(value)) names.add(name)
    }
    expressions.forEach(collect)
    return Object.fromEntries([...names].sort().map((name) => [name, this.params.get(name)])) as Record<string, number>
  }

  /** Gear placements of the last build. */
  gears = new Map<string, GearState | GearError>()
  /** Gear solids in their own frame, by shape key: turning a train only re-places them. */
  private gearLocal = new Map<string, Shape3D>()

  /** Gear facts of the last build, for get_gears. */
  gearReport(): Record<string, unknown>[] {
    return [...this.gears].map(([name, g]) => (g instanceof GearError ? { name, error: g.message } : describeGear(g)))
  }

  /** Cams, geneva drives and belts of the last build. */
  mechanisms: Mechanisms = { cams: new Map(), genevas: new Map(), belts: new Map() }

  mechanismReport(): Record<string, unknown>[] {
    return mechanismReport(this.mechanisms)
  }

  /** Routes the board of the last build with the built-in autorouter. */
  async autoroute(doc: Doc, opts: AutorouteOptions): Promise<AutorouteResult> {
    const st = this.boardState(doc)
    if (!st || !doc.pcb) throw new Error('the project has no board yet; start with set_board')
    if (st.board.errors.length) throw new Error(`fix the board first: ${st.board.errors.join('; ')}`)
    const board = st.board
    const only = opts.nets ? new Set(opts.nets) : undefined
    // Rerouting some nets: their old copper goes, everything else stays as an obstacle.
    const pcb = only ? { ...doc.pcb, tracks: doc.pcb.tracks.filter((t) => !only.has(t.net)), vias: doc.pcb.vias.filter((v) => !only.has(v.net)) } : doc.pcb
    const rules = new Set(['clearance', 'short', 'hole_to_hole', 'copper_to_edge', 'outside_board', 'track_width', 'via'])
    const before = new Set(drc(pcb, board, fillZones(pcb, board)).map((v) => v.message))
    // Only problems the new copper brings in, and only copper rules (silk, placement are not the router's).
    const check = (r: { tracks: Track[]; vias: Via[] }) => {
      const next = { ...pcb, tracks: [...pcb.tracks, ...r.tracks], vias: [...pcb.vias, ...r.vias] }
      return drc(next, board, fillZones(next, board)).filter((v) => !before.has(v.message) && rules.has(v.rule))
    }
    return autorouteBoard(pcb, board, { skip: new Set(opts.skip ?? []), only, timeout: opts.timeout, check })
  }

  motion(doc: Doc): MotionPlan {
    return motionPlan(doc, this.params)
  }

  /** Headless physics: loose bodies' centers over time. */
  async simulate(doc: Doc, seconds: number, samples: number): Promise<Record<string, unknown>> {
    const plan = this.motion(doc)
    if (!plan.physics.length && !plan.moves.length) return { note: 'nothing moves: add physics bodies or joints with set_motion (gear trains move from their first gear rotation parameter)', problems: plan.problems }
    await initPhysics()
    const meshes = this.meshes({ bodies: bodies(doc).map((f) => f.name).filter((n) => this.cache.has(n)) } as BuildResult)
    const world = createWorld(meshes, plan)
    const centers = new Map(meshes.map((m) => [m.name, meshCenter(m)]))
    const r1 = (v: number) => Math.round(v * 10) / 10
    const shots: Record<string, unknown>[] = []
    const dt = 1 / 60
    const total = Math.round(seconds / dt)
    const every = Math.max(1, Math.round(total / samples))
    let last = new Map<string, [number, number, number]>()
    const escaped: string[] = []
    try {
      for (let i = 1; i <= total; i++) {
        const t = i * dt
        world.step(dt, plan.base + (plan.param ? plan.speed * t : 0))
        if (i % every === 0 || i === total) {
          const poses = world.poses()
          const touching = world.contacts()
          const shot: Record<string, unknown> = { t: r1(t), ...(plan.param ? { [plan.param]: r1(plan.base + plan.speed * t) } : {}) }
          for (const p of plan.physics) {
            const pose = poses.get(p.name)
            const c0 = centers.get(p.name)!
            if (!pose) continue
            const rc = rotate(pose.q, c0)
            const c: [number, number, number] = [rc[0] + pose.t[0], rc[1] + pose.t[1], rc[2] + pose.t[2]]
            const prev = last.get(p.name)
            const still = prev ? Math.hypot(c[0] - prev[0], c[1] - prev[1], c[2] - prev[2]) < 0.2 : false
            shot[p.name] = { center: c.map(r1), moved: r1(Math.hypot(c[0] - c0[0], c[1] - c0[1], c[2] - c0[2])), resting: still || undefined, touching: touching.get(p.name)?.length ? touching.get(p.name) : undefined }
            // Watchdog: a loose body inside a solid passed through it.
            const inside = this.insideOf(c, p.name)
            if (inside) {
              escaped.push(`${p.name} is inside "${inside}" at t=${r1(t)} s: it passed through a wall; make the wall thicker or the body slower`)
            }
            last.set(p.name, c)
          }
          shots.push(shot)
          last = new Map(last)
        }
      }
    } finally {
      world.dispose()
    }
    return { param: plan.param, speed: plan.speed, moving: plan.moves.map((m) => m.body), loose: plan.physics.map((p) => p.name), samples: shots, escaped: escaped.length ? [...new Set(escaped)].slice(0, 5) : undefined, problems: plan.problems.length ? plan.problems : undefined }
  }

  /**
   * Interference sweep: steps the driven parameter over a range, poses every
   * moving body and finds pairs of bodies that overlap. Exact: the pose's
   * solids are intersected with OpenCascade for every pair whose bounds
   * meet, so it takes a while; steps × moving pairs boolean operations.
   */
  async sweep(doc: Doc, opts: { from?: number; to?: number; steps?: number; bodies?: string[]; ignore?: [string, string][]; min_volume?: number }): Promise<Record<string, unknown>> {
    const plan = this.motion(doc)
    if (!plan.param) return { error: 'nothing drives the model: make a gear or mechanism rotation an expression of a parameter, or set motion drive' }
    if (!plan.moves.length) return { error: 'nothing moves with ' + plan.param, problems: plan.problems }
    const from = opts.from ?? plan.base
    const to = opts.to ?? plan.base + 360
    const steps = Math.max(1, Math.min(720, opts.steps ?? 72))
    const minVol = opts.min_volume ?? 0.001
    await initPhysics()
    const moves = new Map(plan.moves.map((m) => [m.body, m]))
    const all = bodies(doc)
      .map((f) => f.name)
      .filter((n) => this.cache.has(n))
    const chosen = opts.bodies?.length ? all.filter((n) => opts.bodies!.includes(n)) : all
    const unknown = (opts.bodies ?? []).filter((n) => !all.includes(n))
    if (unknown.length) return { error: `not visible bodies: ${unknown.join(', ')}; bodies are ${all.join(', ')}` }
    const skip = new Set((opts.ignore ?? []).flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]))
    // A belt rides on its pulleys: that contact is the point.
    for (const f of doc.features) if (f.type === 'belt') for (const p of f.pulleys) if (p.body) skip.add(`${f.name}|${p.body}`).add(`${p.body}|${f.name}`)
    const pairs: [string, string][] = []
    for (let i = 0; i < chosen.length; i++)
      for (let j = i + 1; j < chosen.length; j++) {
        const a = chosen[i]
        const b = chosen[j]
        if ((moves.has(a) || moves.has(b)) && !skip.has(`${a}|${b}`)) pairs.push([a, b])
      }
    const posed = (name: string, d: number): Body => {
      const s = this.body(name)
      const mv = moves.get(name)
      if (!mv) return s
      const p = drivenPose(mv, d)
      const { axis, angle } = quatAxisAngle(p.q)
      if (isMesh(s)) {
        let out = s
        if (angle) out = out.rotateAbout(angle, [0, 0, 0], axis)
        if (p.t[0] || p.t[1] || p.t[2]) out = out.translate(p.t)
        return out
      }
      let out = s
      if (angle) out = out.rotate(angle, [0, 0, 0], axis)
      if (p.t[0] || p.t[1] || p.t[2]) out = out.translate(p.t[0], p.t[1], p.t[2])
      return out
    }
    const hits = new Map<string, { first: number; last: number; volume: number; depth: number; at: number; count: number }>()
    const started = performance.now()
    let done = 0
    let stopped = false
    // Broad phase on the display meshes with Rapier (milliseconds per pair):
    // only pairs whose meshes touch go to the exact OpenCascade intersection
    // (about a second for two gears). The meshes sit within their tolerance
    // inside curved surfaces, so overlaps under ~0.05 mm can slip through.
    const meshes = new Map(this.meshes({ bodies: chosen } as BuildResult).map((m) => [m.name, m]))
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 })
    const colliders = new Map<string, RAPIER.Collider>()
    for (const [name, m] of meshes) {
      const d = RAPIER.ColliderDesc.trimesh(m.vertices, m.triangles, RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES | RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES)
      colliders.set(name, world.createCollider(d))
    }
    // Penetration depth of two meshes (> 0 overlap), undefined when apart.
    const depth = (a: string, b: string): number | undefined => {
      const ca = colliders.get(a)
      const cb = colliders.get(b)
      if (!ca || !cb) return 0
      try {
        const c = ca.contactCollider(cb, 0.01)
        return c && c.distance < 0.01 ? -c.distance : undefined
      } catch {
        return 0
      }
    }
    try {
      for (let i = 0; i <= steps && !stopped; i++) {
        const v = from + ((to - from) * i) / steps
        const d = v - plan.base
        for (const [name, c] of colliders) {
          const mv = moves.get(name)
          if (!mv) continue
          const p = drivenPose(mv, d)
          c.setTranslation({ x: p.t[0], y: p.t[1], z: p.t[2] })
          c.setRotation({ x: p.q[0], y: p.q[1], z: p.q[2], w: p.q[3] })
        }
        const cache = new Map<string, Body>()
        const get = (n: string) => {
          let s = cache.get(n)
          if (!s) cache.set(n, (s = posed(n, d)))
          return s
        }
        for (const [a, b] of pairs) {
          const pen = depth(a, b)
          if (pen === undefined) continue
          const key = `${a}|${b}`
          const h = hits.get(key)
          // A pair already confirmed: follow it on the meshes (fast).
          if (h) {
            if (pen > 0.02) {
              h.last = v
              h.count++
              if (pen > h.depth) {
                h.depth = pen
                h.at = v
              }
            }
            continue
          }
          // First contact: confirm with the exact solids.
          const A = get(a)
          const B = get(b)
          const [la, ha] = bodyBox(A)
          const [lb, hb] = bodyBox(B)
          if (la.some((x, k) => x > hb[k] || lb[k] > ha[k])) continue
          let vol: number
          if (isMesh(A) || isMesh(B)) {
            const ma = isMesh(A) ? A : brepToMesh(A, a)
            const mb = isMesh(B) ? B : brepToMesh(B, b)
            vol = ma.overlap(mb).volume
            if (ma !== A) ma.delete()
            if (mb !== B) mb.delete()
          } else vol = overlapVolume(A, B)
          if (vol > minVol) hits.set(key, { first: v, last: v, volume: vol, depth: Math.max(0, pen), at: v, count: 1 })
        }
        for (const s of cache.values()) s.delete()
        done = i
        if (performance.now() - started > 40_000) stopped = true
      }
    } finally {
      world.free()
    }
    const r = (x: number) => Math.round(x * 1000) / 1000
    const collisions = [...hits].map(([k, h]) => {
      const [a, b] = k.split('|')
      return { a, b, first: r(h.first), last: r(h.last), steps: h.count, volume_at_first: r(h.volume), worst_depth: r(h.depth), worst_at: r(h.at) }
    })
    collisions.sort((x, y) => x.first - y.first)
    return {
      param: plan.param,
      from: r(from),
      to: r(to),
      steps: done,
      step: r((to - from) / steps),
      pairs: pairs.length,
      clear: collisions.length === 0,
      collisions,
      ...(stopped ? { note: `stopped after ${done} of ${steps} steps (time limit); sweep a smaller range, fewer steps or fewer bodies` } : {}),
      ...(plan.problems.length ? { problems: plan.problems } : {}),
    }
  }

  /** The still solid a point lies inside, if any (driven bodies move, so they are not checked). */
  private insideOf(p: [number, number, number], self: string): string | undefined {
    const plan = this.doc ? this.motion(this.doc) : undefined
    const moving = new Set([...(plan?.moves.map((m) => m.body) ?? []), ...(plan?.physics.map((x) => x.name) ?? [])])
    for (const f of this.doc ? bodies(this.doc) : []) {
      if (f.name === self || moving.has(f.name) || !this.cache.has(f.name)) continue
      const s = this.cache.get(f.name)!
      const [lo, hi] = bodyBox(s.shape)
      if (p.some((v, i) => v < lo[i] || v > hi[i])) continue
      const r = this.between(p, f.name) as { distance?: number }
      if (r.distance === 0) return f.name
    }
    return undefined
  }

  private gearShape(f: Extract<Feature, { type: 'gear' }>, warnings: string[]): Shape3D {
    const g = this.gears.get(f.name)
    if (!g) throw new Error('gear was not solved')
    if (g instanceof GearError) throw g
    warnings.push(...g.warnings)
    const o = gearOptions(f, this.params)
    const key = localKey(g, o)
    let local = this.gearLocal.get(key)
    if (!local) {
      local = gearLocalShape(g, o, f.name)
      this.gearLocal.set(key, local)
      // Keep the cache small: a few shapes per gear is plenty.
      if (this.gearLocal.size > 64) {
        const first = this.gearLocal.keys().next().value!
        this.gearLocal.get(first)?.delete()
        this.gearLocal.delete(first)
      }
    }
    return placeGear(local.clone() as Shape3D, g)
  }

  /** A fresh copy of a built feature; the caller owns it. */
  body(name: string): Body {
    const c = this.cache.get(name)
    if (!c) {
      const known = [...this.cache.keys()]
      throw new Error(`no feature "${name}"${known.length ? `; features are: ${known.join(', ')}` : ' (the model is empty)'}`)
    }
    return c.shape.clone() as Body
  }

  /** A fresh copy of a built feature as a mesh body (B-rep solids are tessellated once and kept). */
  meshOf(name: string): MeshBody {
    const c = this.cache.get(name)
    if (!c) return this.body(name) as MeshBody
    if (isMesh(c.shape)) return c.shape.clone()
    c.meshed ??= brepToMesh(c.shape, name)
    return c.meshed.clone()
  }

  /** A fresh copy of a built B-rep feature; says what to do when it is a mesh body. */
  shape(name: string, why = 'this operation'): Shape3D {
    const b = this.body(name)
    if (isMesh(b)) {
      b.delete()
      throw new Error(`"${name}" is a triangle mesh (imported STL / 3MF), and ${why} needs a B-rep solid with faces and edges; use boolean, transform, pattern or mirror on it, or model this part as a B-rep (box, extrude, ...) and combine it with the mesh`)
    }
    return b
  }

  private isMeshBody(name: string): boolean {
    const c = this.cache.get(name)
    return !!c && isMesh(c.shape)
  }

  has(name: string): boolean {
    return this.cache.has(name)
  }

  private make(f: Feature, warnings: string[]): Body {
    const p = this.params
    const n = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, p, `${f.name}.${field}`, fb)

    // A feature over a triangle-mesh body works on meshes (B-rep inputs are tessellated for it).
    if (inputsOf(f).some((i) => this.isMeshBody(i))) return this.makeMesh(f, warnings)
    if (f.type === 'solids') return this.pickSolids(f)
    if (f.type === 'transform' && f.align) {
      const s = place(this.shape(f.target), { rotate: f.rotate }, p, f.name)
      const [dx, dy, dz] = this.alignOffset(f, bboxOf(s))
      return s.translate(dx, dy, dz)
    }

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
      case 'gear':
        return this.gearShape(f, warnings)
      case 'cam':
      case 'geneva':
      case 'belt':
        return mechanismShape(f, this.mechanisms, this.params, warnings)
      case 'text': {
        const font = f.font ?? 'regular'
        const metrics = fontMetrics(font)
        if (!metrics) throw new Error(`font "${font}" is not loaded in this kernel`)
        if (!f.text.trim()) throw new Error('text is empty')
        const size = n(f.size, 'size')
        const depth = n(f.depth, 'depth')
        if (size <= 0) throw new Error('size (cap height in mm) must be > 0')
        if (!depth) throw new Error('depth must not be 0; negative goes into the plane, e.g. to engrave')
        let d: R.Drawing
        try {
          d = R.drawText(f.text, { fontSize: size / metrics.capHeight, fontFamily: font })
        } catch (e) {
          throw new Error(`cannot draw "${f.text}" with font ${font}: ${kernelMessage(e)}; use plain letters, digits and punctuation`)
        }
        const [[x0], [x1]] = d.boundingBox.bounds
        const anchor = f.anchor ?? 'center'
        const dx = anchor === 'left' ? -x0 : anchor === 'right' ? -x1 : -(x0 + x1) / 2
        // Cap height is centred on at: the baseline sits size/2 below it.
        d = d.translate(dx, -size / 2)
        const ang = n(f.angle, 'angle', 0)
        if (ang) d = d.rotate(ang, [0, 0])
        const [ax, ay] = f.at ? [n(f.at[0], 'at[0]'), n(f.at[1], 'at[1]')] : [0, 0]
        if (ax || ay) d = d.translate(ax, ay)
        const plane = f.plane
        const flip = plane === 'XZ' ? -1 : 1
        const solid = onPlane(d, plane, n(f.offset, 'offset', 0)).extrude(depth * flip) as Shape3D
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
        const apart: string[] = []
        if (f.op === 'intersect') {
          for (const t of f.tools) s = s.intersect(this.shape(t)) as Shape3D
        } else {
          // Tools that are clear of each other go into one OpenCascade
          // operation as a compound: one pass over the target instead of one
          // per tool (5-6x faster on a case with many bosses and cut-outs).
          // Tools that may overlap each other stay in separate passes, since
          // a boolean needs arguments that do not interfere.
          const targetBox = bboxOf(s)
          const solids0 = s.solids?.length ?? 1
          const tools = f.tools.map((name) => {
            const shape = this.shape(name)
            return { name, shape, box: bboxOf(shape) }
          })
          const clear = (a: BBox, b: BBox) => a[0].some((lo, k) => lo > b[1][k] + 0.01 || b[0][k] > a[1][k] + 0.01)
          const groups: (typeof tools)[] = []
          for (const t of tools) {
            const g = groups.find((g) => g.every((o) => clear(o.box, t.box)))
            if (g) g.push(t)
            else groups.push([t])
          }
          for (const g of groups) {
            const tool = g.length === 1 ? g[0].shape : (R.makeCompound(g.map((t) => t.shape)) as Shape3D)
            s = f.op === 'union' ? s.fuse(tool) : s.cut(tool)
          }
          if (f.op === 'cut') {
            // A tool that is clear of the target (outside it, or loose in its cavity) cut nothing.
            const all = Math.abs(volumeOf(s) - before) < 1e-6
            const base = all ? undefined : this.shape(f.target)
            for (const t of f.tools) {
              let missed = all
              if (base) {
                const tool = this.shape(t)
                missed = clear(bboxOf(tool), targetBox) || safeDistance(base, tool) > 1e-6
                tool.delete()
              }
              if (missed) warnings.push(`cutting "${t}" removed no material: it does not overlap "${f.target}"`)
            }
            base?.delete()
          } else if (!f.separate && (s.solids?.length ?? 1) > solids0) {
            // Only a union that really fell apart pays for the distance
            // checks: a tool is apart when no chain of touching tools leads
            // from it to the target.
            const parts = [f.target, ...f.tools].map((name) => {
              const shape = this.shape(name)
              return { name, shape, box: bboxOf(shape) }
            })
            const joined = new Set([f.target])
            const queue = [parts[0]]
            while (queue.length) {
              const a = queue.pop()!
              for (const b of parts) {
                if (joined.has(b.name) || clear(a.box, b.box) || safeDistance(a.shape, b.shape) > 1e-6) continue
                joined.add(b.name)
                queue.push(b)
              }
            }
            for (const t of parts) {
              if (!joined.has(t.name)) apart.push(t.name)
              t.shape.delete()
            }
          }
        }
        if (apart.length) {
          const list = apart.length > 5 ? `${apart.slice(0, 5).map((t) => `"${t}"`).join(', ')} and ${apart.length - 5} more` : apart.map((t) => `"${t}"`).join(', ')
          warnings.push(`${list} do${apart.length === 1 ? 'es' : ''} not touch the rest: the union holds separate solids (pass separate: true if that is intended, e.g. keys or wheels)`)
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
      case 'import': {
        const k = n(f.scale, 'scale', 1)
        if (k <= 0) throw new Error('scale must be > 0')
        const body = this.importedBody(f.url, f.name)
        if (isMesh(body)) {
          const scaled = k !== 1 ? body.scale(k) : body
          return scaled.place(vec(f.rotate, p, `${f.name}.rotate`), vec(f.translate, p, `${f.name}.translate`))
        }
        let shape = body
        if (k !== 1) shape = shape.scale(k, [0, 0, 0]) as Shape3D
        return place(shape, f, p, f.name)
      }
      case 'pattern': {
        const base = this.shape(f.target)
        if (f.kind === 'polar') {
          const count = Math.round(n(f.count, 'count'))
          if (count < 1 || count > 500) throw new Error('count must be between 1 and 500')
          const total = n(f.angle, 'angle', 360)
          if (total <= 0 || total > 360) throw new Error('angle must be in (0, 360]')
          const center = vec(f.center, p, `${f.name}.center`)
          const dir = AXES[f.axis ?? 'Z']
          const step = total >= 360 ? 360 / count : count > 1 ? total / (count - 1) : 0
          let out: Shape3D | undefined
          for (let i = 0; i < count; i++) {
            let copy = base.clone() as Shape3D
            if (i) copy = copy.rotate(step * i, center, dir)
            out = out ? out.fuse(copy) : copy
          }
          base.delete()
          return out!
        }
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
      case 'mirror': {
        const s = this.shape(f.target)
        const off = n(f.offset, 'offset', 0)
        const normal: V3 = f.plane === 'XY' ? [0, 0, 1] : f.plane === 'XZ' ? [0, 1, 0] : [1, 0, 0]
        const origin: V3 = [normal[0] * off, normal[1] * off, normal[2] * off]
        const image = (s.clone() as Shape3D).mirror(normal, origin)
        if (f.keep === false) {
          s.delete()
          return image
        }
        return s.fuse(image)
      }
    }
  }

  /** Features whose inputs include a mesh body: booleans, transforms, patterns and mirrors on meshes. */
  private makeMesh(f: Feature, warnings: string[]): MeshBody {
    const p = this.params
    const n = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, p, `${f.name}.${field}`, fb)
    switch (f.type) {
      case 'boolean': {
        if (!f.tools.length) throw new Error('tools must name at least one feature')
        const target = this.meshOf(f.target)
        const before = target.volume()
        const targetBox = target.bbox()
        const tools = f.tools.map((t) => ({ name: t, body: this.meshOf(t) }))
        const clear = (a: BBox, b: BBox) => a[0].some((lo, k) => lo > b[1][k] + 0.01 || b[0][k] > a[1][k] + 0.01)
        if (f.op === 'cut') {
          for (const t of tools) {
            if (clear(t.body.bbox(), targetBox) || target.overlap(t.body).volume < 1e-6) warnings.push(`cutting "${t.name}" removed no material: it does not overlap "${f.target}"`)
          }
        }
        const solids0 = f.op === 'union' && !f.separate ? target.solids() : 0
        const out = target.boolean(f.op, tools.map((t) => t.body))
        const after = out.volume()
        if (f.op === 'intersect' && after < 1e-9) warnings.push('the intersection is empty')
        if (f.op === 'union' && before > 0 && Math.abs(after - before) < 1e-6) warnings.push('the union added no material')
        if (f.op === 'union' && !f.separate && out.solids() > solids0) warnings.push('some tools do not touch the rest: the union holds separate solids (pass separate: true if that is intended, e.g. keys or wheels)')
        return out
      }
      case 'transform': {
        const rotated = this.meshOf(f.target).place(vec(f.rotate, p, `${f.name}.rotate`), [0, 0, 0])
        const t = f.align ? this.alignOffset(f, rotated.bbox()) : vec(f.translate, p, `${f.name}.translate`)
        return rotated.translate(t)
      }
      case 'mirror': {
        const s = this.meshOf(f.target)
        const off = n(f.offset, 'offset', 0)
        const normal: V3 = f.plane === 'XY' ? [0, 0, 1] : f.plane === 'XZ' ? [0, 1, 0] : [1, 0, 0]
        const origin: V3 = [normal[0] * off, normal[1] * off, normal[2] * off]
        const image = s.clone().mirror(normal, origin)
        if (f.keep === false) {
          s.delete()
          return image
        }
        return s.boolean('union', [image])
      }
      case 'pattern': {
        const base = this.meshOf(f.target)
        const copies: MeshBody[] = []
        if (f.kind === 'polar') {
          const count = Math.round(n(f.count, 'count'))
          if (count < 1 || count > 500) throw new Error('count must be between 1 and 500')
          const total = n(f.angle, 'angle', 360)
          if (total <= 0 || total > 360) throw new Error('angle must be in (0, 360]')
          const center = vec(f.center, p, `${f.name}.center`)
          const dir = AXES[f.axis ?? 'Z']
          const step = total >= 360 ? 360 / count : count > 1 ? total / (count - 1) : 0
          for (let i = 1; i < count; i++) copies.push(base.clone().rotateAbout(step * i, center, dir))
        } else {
          const offsets: V3[] = []
          if (f.kind === 'linear') {
            const count = Math.round(n(f.count, 'count'))
            if (count < 1 || count > 500) throw new Error('count must be between 1 and 500')
            const step = vec(f.step, p, `${f.name}.step`)
            for (let i = 1; i < count; i++) offsets.push([step[0] * i, step[1] * i, step[2] * i])
          } else {
            const cx = Math.round(num(f.count[0], p, `${f.name}.count[0]`))
            const cy = Math.round(num(f.count[1], p, `${f.name}.count[1]`))
            if (cx < 1 || cy < 1 || cx * cy > 2000) throw new Error('count must be ≥ 1 per axis and at most 2000 in total')
            const sx = num(f.step[0], p, `${f.name}.step[0]`)
            const sy = num(f.step[1], p, `${f.name}.step[1]`)
            for (let i = 0; i < cx; i++) for (let j = 0; j < cy; j++) if (i || j) offsets.push([sx * i, sy * j, 0])
          }
          for (const o of offsets) copies.push(base.clone().translate(o))
        }
        return copies.length ? base.boolean('union', copies) : base
      }
      case 'fillet':
      case 'chamfer':
      case 'shell':
        throw new Error(`"${f.target}" is a triangle mesh (imported STL / 3MF): ${f.type} needs a B-rep solid with edges and faces. Round or hollow the B-rep parts before combining them with the mesh, or cut a shaped tool out of the mesh with boolean`)
      default:
        throw new Error(`${f.type} does not work on triangle meshes`)
    }
  }

  /** The move that puts the align anchor of box at align.to, plus translate. */
  private alignOffset(f: Extract<Feature, { type: 'transform' }>, box: BBox): V3 {
    const p = this.params
    const to = vec(f.align!.to, p, `${f.name}.align.to`)
    const extra = vec(f.translate, p, `${f.name}.translate`)
    const anchor = f.align!.anchor ?? ['center', 'center', 'min']
    return [0, 1, 2].map((k) => {
      const a = anchor[k] === 'min' ? box[0][k] : anchor[k] === 'max' ? box[1][k] : (box[0][k] + box[1][k]) / 2
      return to[k] - a + extra[k]
    }) as V3
  }

  /** The separate solids of a body, with what list_solids reports. */
  private solidsOf(name: string): { body: Body; box: BBox; volume: number; center: V3 }[] {
    const b = this.body(name)
    let parts: Body[]
    if (isMesh(b)) {
      parts = b.parts()
      b.delete()
    } else {
      const s = (b as unknown as { solids?: Shape3D[] }).solids
      parts = s && s.length > 1 ? s.map((x) => x.clone() as Shape3D) : [b]
      if (parts[0] !== b) b.delete()
    }
    return parts.map((body) => {
      const box = bodyBox(body)
      return { body, box, volume: bodyVolume(body), center: r3([(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2, (box[0][2] + box[1][2]) / 2]) }
    })
  }

  /** list_solids: each separate solid of a body. */
  listSolids(name: string): { index: number; bbox: BBox; size: V3; center: V3; volume: number }[] {
    const list = this.solidsOf(name)
    try {
      return list.map((s, index) => ({ index, bbox: s.box, size: r3([s.box[1][0] - s.box[0][0], s.box[1][1] - s.box[0][1], s.box[1][2] - s.box[0][2]]), center: s.center, volume: round(s.volume, 3) }))
    } finally {
      for (const s of list) s.body.delete()
    }
  }

  private pickSolids(f: Extract<Feature, { type: 'solids' }>): Body {
    const p = this.params
    const all = this.solidsOf(f.source).map((s, index) => ({ ...s, index }))
    let chosen = all
    const pick = f.pick ?? {}
    if (pick.index) {
      const bad = pick.index.filter((i) => i >= all.length)
      if (bad.length) throw new Error(`"${f.source}" has ${all.length} solids (index 0..${all.length - 1}); there is no ${bad.join(', ')}; see list_solids`)
      chosen = chosen.filter((s) => pick.index!.includes(s.index))
    }
    if (pick.inBox) {
      const a = vec(pick.inBox[0], p, `${f.name}.pick.inBox[0]`)
      const b = vec(pick.inBox[1], p, `${f.name}.pick.inBox[1]`)
      chosen = chosen.filter((s) => s.center.every((v, k) => v >= Math.min(a[k], b[k]) - 1e-6 && v <= Math.max(a[k], b[k]) + 1e-6))
    }
    if (pick.near) {
      const q = vec(pick.near, p, `${f.name}.pick.near`)
      // Nearest by box first (cheap), then the exact distance for solids whose box is that close.
      const boxGap = (bx: BBox) => Math.hypot(...[0, 1, 2].map((k) => Math.max(bx[0][k] - q[k], 0, q[k] - bx[1][k])))
      const ranked = chosen.map((s) => ({ s, gap: boxGap(s.box) })).sort((x, y) => x.gap - y.gap)
      if (ranked.length) {
        const exact = (s: (typeof all)[number]) => {
          if (isMesh(s.body)) {
            const probe = meshCube([q[0] - 1e-4, q[1] - 1e-4, q[2] - 1e-4], [q[0] + 1e-4, q[1] + 1e-4, q[2] + 1e-4])
            try {
              return s.body.overlap(probe).volume > 0 ? 0 : s.body.distance(probe)
            } finally {
              probe.delete()
            }
          }
          const probe = R.makeSphere(1e-4).translate(q[0], q[1], q[2]) as Shape3D
          try {
            return safeDistance(s.body as Shape3D, probe)
          } finally {
            probe.delete()
          }
        }
        let best = ranked[0].s
        let bestD = Infinity
        for (const { s, gap } of ranked) {
          if (gap > bestD) break
          const d = exact(s)
          if (d < bestD) {
            bestD = d
            best = s
          }
        }
        chosen = [best]
      }
    }
    if (pick.largest) chosen = [...chosen].sort((x, y) => y.volume - x.volume).slice(0, pick.largest)
    for (const s of all) if (!chosen.includes(s)) s.body.delete()
    if (!chosen.length) throw new Error(`no solid of "${f.source}" matches the pick; list_solids shows its ${all.length} solids with their boxes and centers`)
    if (chosen.length === 1) return chosen[0].body
    const bodies = chosen.map((s) => s.body)
    if (bodies.some(isMesh)) {
      const meshes = bodies.map((b) => (isMesh(b) ? b : brepToMesh(b, f.name)))
      bodies.forEach((b, i) => b !== meshes[i] && b.delete())
      return composeBodies(meshes)
    }
    return R.makeCompound(bodies as Shape3D[]) as unknown as Shape3D
  }

  /**
   * Cross-sections of bodies by a plane normal to axis at a coordinate: per
   * body, its closed outlines (in the plane's (u, v): X → (y, z), Y → (x, z),
   * Z → (x, y)), their boxes and the cut area. B-rep bodies are cut on a fine
   * tessellation (within 0.01 mm).
   */
  section(names: string[], axis: 'X' | 'Y' | 'Z', at: number, simplify = 0.05): Record<string, unknown>[] {
    const k = { X: 0, Y: 1, Z: 2 }[axis]
    const [u, v] = { X: ['y', 'z'], Y: ['x', 'z'], Z: ['x', 'y'] }[axis]
    return names.map((name) => {
      const box = this.cache.get(name)?.status.bbox
      if (box && (at < box[0][k] || at > box[1][k])) return { name, cut: false, note: `the plane ${axis}=${at} misses ${name} (it spans ${box[0][k]}..${box[1][k]})` }
      const m = this.meshOf(name)
      try {
        const { outlines, area } = m.section(axis, at)
        const loops = outlines
          .map((ring) => {
            const pts = simplifyRing(ring, simplify)
            let a = 0
            for (let i = 0; i < pts.length; i++) {
              const [x0, y0] = pts[i]
              const [x1, y1] = pts[(i + 1) % pts.length]
              a += x0 * y1 - x1 * y0
            }
            const us = pts.map((p) => p[0])
            const vs = pts.map((p) => p[1])
            return {
              kind: a >= 0 ? 'material' : 'hole',
              area: round(Math.abs(a) / 2, 2),
              box: [[round(Math.min(...us), 2), round(Math.min(...vs), 2)], [round(Math.max(...us), 2), round(Math.max(...vs), 2)]],
              points: pts.length <= 64 ? pts.map((p) => [round(p[0], 2), round(p[1], 2)]) : undefined,
              point_count: pts.length,
            }
          })
          .sort((x, y) => y.area - x.area)
        return { name, cut: true, axes: [u, v], area: round(area, 2), loops: loops.slice(0, 40), ...(loops.length > 40 ? { more_loops: loops.length - 40 } : {}) }
      } finally {
        m.delete()
      }
    })
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

  private describe(f: Feature, s: Body, warnings: string[]): FeatureStatus {
    const st: FeatureStatus = { name: f.name, type: f.type, ok: true }
    if (isMesh(s)) {
      st.bbox = bodyBox(s)
      st.volume = round(s.volume(), 3)
      st.solids = s.solids()
      st.triangles = s.triangles
      if (st.solids > 1 && f.type !== 'pattern' && f.type !== 'mirror' && f.type !== 'import' && !(f.type === 'boolean' && (f.separate || warnings.some((w) => w.includes('separate solids'))))) warnings.push(`the result has ${st.solids} separate solids`)
      if (st.volume <= 0) warnings.push('the result has no volume')
      if (warnings.length) st.warnings = warnings
      return st
    }
    try {
      st.bbox = bboxOf(s)
      st.volume = round(volumeOf(s), 3)
      st.solids = s.solids?.length ?? 1
      const quick = faceCount(s, 200)
      // Counting distinct faces and edges of a vendor model takes seconds; walk them only for normal bodies.
      if (quick > 200) st.faces = faceCount(s)
      else {
        st.faces = countTopo(s, 'face')
        st.edges = countTopo(s, 'edge')
      }
    } catch {
      // A shape without a bounding box is still valid (empty intersect).
    }
    if ((st.solids ?? 1) > 1 && f.type !== 'pattern' && f.type !== 'mirror' && !(f.type === 'boolean' && (f.separate || warnings.some((w) => w.includes('separate solids'))))) warnings.push(`the result has ${st.solids} separate solids`)
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
      if (!m && isMesh(c.shape)) {
        const d = displayMesh(c.shape)
        m = { name, key, vertices: d.vertices, normals: d.normals, triangles: d.triangles, edges: d.edges, edgeGroups: new Uint32Array(0), faceGroups: new Uint32Array([0, d.triangles.length / 3]) }
        this.meshCache.set(key, m)
      }
      if (!m) {
        const shape = c.shape as Shape3D
        // Vendor models (imports, part models) carry tiny fillets and text:
        // a looser tolerance keeps them light (a few thousand triangles, not
        // hundreds of thousands) and still looks right at viewing scale.
        const vendor = c.status.type === 'import'
        const tol = vendor ? Math.max(tolerance, 0.03 * Math.cbrt(Math.max(c.status.volume ?? 1, 1))) : tolerance
        const ang = vendor ? 0.5 : 0.2
        const mesh = shape.mesh({ tolerance: tol, angularTolerance: ang })
        const edges = vendor ? { lines: [] as number[], edgeGroups: [] as { start: number; count: number }[] } : shape.meshEdges({ tolerance, angularTolerance: 0.2 })
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
      const color = f?.color ?? (name === BOARD && this.doc?.pcb ? boardStyle(this.doc.pcb).maskColor : name.startsWith(PART_PREFIX) ? '#30343b' : undefined)
      const material = f?.material ? this.doc?.materials?.find((x) => x.name === f.material) : undefined
      const decals = this.resolvedDecals(name)
      const explode = this.doc ? explodeOffset(this.doc, this.params, name) : undefined
      out.push({ ...m, name, color, opacity: f?.opacity, ...(material ? { material } : {}), ...(decals.length ? { decals } : {}), ...(explode ? { explode } : {}) })
    }
    for (const k of [...this.meshCache.keys()]) if (!live.has(k)) this.meshCache.delete(k)
    return out
  }

  /** Decals on a body with their expressions resolved; bad ones are skipped (build reports them). */
  private resolvedDecals(target: string): ResolvedDecal[] {
    const out: ResolvedDecal[] = []
    for (const d of this.doc?.decals ?? []) {
      if (d.target !== target) continue
      try {
        out.push(resolveDecal(d, this.params))
      } catch {
        // reported by appearanceStatus
      }
    }
    return out
  }

  /** Problems with materials and decals, for the build result and the model. */
  appearanceStatus(doc: Doc): string[] {
    const problems: string[] = []
    const names = new Set(doc.features.map((f) => f.name))
    const bodySet = new Set(bodies(doc).map((f) => f.name))
    for (const f of doc.features) {
      if (f.material && !doc.materials?.some((m) => m.name === f.material)) problems.push(`feature "${f.name}" uses material "${f.material}", which does not exist`)
    }
    for (const d of doc.decals ?? []) {
      if (!names.has(d.target)) problems.push(`decal "${d.name}": target "${d.target}" does not exist`)
      else if (!bodySet.has(d.target)) problems.push(`decal "${d.name}": "${d.target}" is not a visible body (it is used by a later feature); put the decal on the final body`)
      try {
        resolveDecal(d, this.params)
      } catch (e) {
        problems.push(`decal "${d.name}": ${(e as Error).message}`)
      }
    }
    return problems
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

  /** Distance between two built features: OpenCascade for two B-rep solids, meshes when either is a mesh. */
  private distanceOf(a: string, b: string): number {
    if (this.isMeshBody(a) || this.isMeshBody(b)) {
      const [ma, mb] = [this.meshOf(a), this.meshOf(b)]
      try {
        return ma.distance(mb)
      } finally {
        ma.delete()
        mb.delete()
      }
    }
    const [sa, sb] = [this.shape(a), this.shape(b)]
    try {
      return safeDistance(sa, sb)
    } finally {
      sa.delete()
      sb.delete()
    }
  }

  private overlapOf(a: string, b: string): { volume: number; regions: { box: [V3, V3]; volume: number }[] } {
    if (this.isMeshBody(a) || this.isMeshBody(b)) {
      const [ma, mb] = [this.meshOf(a), this.meshOf(b)]
      try {
        const o = ma.overlap(mb)
        return { volume: o.volume, regions: o.regions.map((r) => ({ box: [r3(r.box[0]), r3(r.box[1])] as [V3, V3], volume: round(r.volume, 4) })) }
      } finally {
        ma.delete()
        mb.delete()
      }
    }
    const [sa, sb] = [this.shape(a), this.shape(b)]
    try {
      return overlapRegions(sa, sb)
    } finally {
      sa.delete()
      sb.delete()
    }
  }

  measure(a: string, b?: string): Record<string, unknown> {
    if (this.isMeshBody(a)) {
      const m = this.meshOf(a)
      try {
        const [lo, hi] = bodyBox(m)
        const out: Record<string, unknown> = {
          name: a,
          bbox: [lo, hi],
          size: r3([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]),
          volume: round(m.volume(), 3),
          area: round(m.area(), 3),
          center_of_mass: r3(m.centerOfMass()),
          triangles: m.triangles,
        }
        if (b) {
          out.other = b
          out.distance = round(this.distanceOf(a, b), 4)
          out.overlap_volume = round(this.overlapOf(a, b).volume, 4)
        }
        return out
      } finally {
        m.delete()
      }
    }
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
        out.other = b
        out.distance = round(this.distanceOf(a, b), 4)
        out.overlap_volume = round(this.overlapOf(a, b).volume, 4)
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
    const meshy = (!isPt(a) && this.isMeshBody(a)) || (!isPt(b) && this.isMeshBody(b))
    if (meshy) {
      if (!isPt(a) && !isPt(b)) {
        const ov = this.overlapOf(a, b)
        const out: Record<string, unknown> = { a, b, distance: round(this.distanceOf(a, b), 4), overlap_volume: round(ov.volume, 4) }
        if (ov.volume > 1e-6) out.overlap = ov.regions.slice(0, 8)
        return out
      }
      const pt = (isPt(a) ? a : b) as V3
      const name = (isPt(a) ? b : a) as string
      const probe = meshCube([pt[0] - 1e-4, pt[1] - 1e-4, pt[2] - 1e-4], [pt[0] + 1e-4, pt[1] + 1e-4, pt[2] + 1e-4])
      const m = this.meshOf(name)
      try {
        const inside = m.overlap(probe).volume > 0
        const out: Record<string, unknown> = { a, b, distance: inside ? 0 : round(Math.max(0, m.distance(probe) - 1e-4), 4) }
        if (out.distance === 0) out.note = 'the point is on or inside the feature'
        return out
      } finally {
        m.delete()
        probe.delete()
      }
    }
    const shape = (v: string | V3) => (isPt(v) ? (R.makeSphere(1e-4).translate(v[0], v[1], v[2]) as Shape3D) : this.shape(v))
    const sa = shape(a)
    const sb = shape(b)
    try {
      const out: Record<string, unknown> = { a, b, distance: round(Math.max(0, safeDistance(sa, sb) - (isPt(a) || isPt(b) ? 1e-4 : 0)), 4) }
      if (!isPt(a) && !isPt(b)) {
        const ov = overlapRegions(sa, sb)
        out.overlap_volume = round(ov.volume, 4)
        // Where they clash: one box per separate piece of the overlap (largest first).
        if (ov.volume > 1e-6) out.overlap = ov.regions.slice(0, 8)
      }
      if (out.distance === 0 && (isPt(a) || isPt(b))) out.note = 'the point is on or inside the feature'
      return out
    } finally {
      sa.delete()
      sb.delete()
    }
  }

  /** Results of pairwise body checks by the bodies' build keys: unchanged pairs are not intersected again. */
  private pairCache = new Map<string, number>()

  /** Cached pairwise measure (overlap volume or distance); boxes that are apart skip OpenCascade. */
  private pair(kind: 'overlap' | 'distance', a: string, b: string, compute: () => number, min = 0): number {
    const ca = this.cache.get(a)
    const cb = this.cache.get(b)
    if (!ca || !cb) return compute()
    // Board bodies share one build key: the names make the pair unique.
    const key = `${kind}|${a}|${ca.key}|${b}|${cb.key}|${min}`
    const hit = this.pairCache.get(key)
    if (hit !== undefined) return hit
    let v: number | undefined
    const ba = ca.status.bbox
    const bb = cb.status.bbox
    if (ba && bb) {
      // Gap between the boxes: > 0 means they cannot touch.
      let gap = 0
      for (let i = 0; i < 3; i++) gap = Math.max(gap, ba[0][i] - bb[1][i], bb[0][i] - ba[1][i])
      if (kind === 'overlap' && gap > 1e-3) v = 0
      // A distance check only needs the exact value when the boxes are closer than the limit.
      if (kind === 'distance' && gap > min + 1e-3) v = gap
    }
    if (v === undefined) v = compute()
    if (this.pairCache.size > 4000) this.pairCache.clear()
    this.pairCache.set(key, v)
    return v
  }

  private boxApart(a: string, b: string, min: number): boolean {
    const ba = this.cache.get(a)?.status.bbox
    const bb = this.cache.get(b)?.status.bbox
    if (!ba || !bb) return false
    let gap = 0
    for (let i = 0; i < 3; i++) gap = Math.max(gap, ba[0][i] - bb[1][i], bb[0][i] - ba[1][i])
    return gap > min + 1e-3
  }

  checks(doc: Doc): CheckResult[] {
    return doc.checks.map((c) => {
      const t = Date.now()
      const r = this.check(c)
      const ms = Date.now() - t
      return ms >= 200 ? { ...r, ms } : r
    })
  }

  private check(c: Check): CheckResult {
    const p = this.params
    {
      const base = { name: c.name, kind: c.kind, note: c.note }
      try {
        switch (c.kind) {
          case 'expr': {
            const v = num(c.expr, p, `check ${c.name}`)
            return { ...base, ok: v !== 0, detail: v !== 0 ? `${c.expr} holds` : `${c.expr} is false` }
          }
          case 'min_distance': {
            const min = num(c.min, p, `check ${c.name}.min`)
            const d = this.pair('distance', c.a, c.b, () => this.distanceOf(c.a, c.b), min)
            const exact = !this.boxApart(c.a, c.b, min)
            return { ...base, ok: d >= min - 1e-6, detail: `distance ${c.a}↔${c.b} ${exact ? '=' : '≥'} ${d.toFixed(3)} mm (min ${min})` }
          }
          case 'no_overlap': {
            const v = this.pair('overlap', c.a, c.b, () => this.overlapOf(c.a, c.b).volume)
            const allow = c.allow ?? 0
            if (v < 1e-6) return { ...base, ok: true, detail: `${c.a} and ${c.b} do not overlap` }
            return { ...base, ok: v <= allow + 1e-6, detail: `${c.a} and ${c.b} overlap by ${v.toFixed(3)} mm³${allow ? ` (allowed ${allow})` : ''}` }
          }
          case 'inside': {
            // inner must lie fully within outer (a body that stands for the
            // free space, e.g. a cavity), keeping margin to every side of
            // outer's bounding box.
            const margin = num(c.margin, p, `check ${c.name}.margin`, 0)
            const [si, so] = [this.body(c.inner), this.body(c.outer)]
            const [ilo, ihi] = bodyBox(si)
            const [olo, ohi] = bodyBox(so)
            const vi = bodyVolume(si)
            si.delete()
            so.delete()
            const within = this.overlapOf(c.inner, c.outer).volume
            // Mesh volumes carry float rounding: allow a tiny fraction of the inner volume.
            const tol = Math.max(1e-6, vi * 1e-6)
            const outside = Math.max(0, vi - within)
            const gaps = [0, 1, 2].flatMap((i) => [ilo[i] - olo[i], ohi[i] - ihi[i]])
            const minGap = Math.min(...gaps)
            const ok = minGap >= margin - 1e-6 && outside < tol
            const axis = ['-X', '+X', '-Y', '+Y', '-Z', '+Z'][gaps.indexOf(minGap)]
            return {
              ...base,
              ok,
              detail:
                (outside >= tol ? `${outside.toFixed(3)} mm³ of ${c.inner} is outside ${c.outer}; ` : '') +
                `smallest gap ${minGap.toFixed(3)} mm on ${axis} (margin ${margin})`,
            }
          }
          case 'volume': {
            const s = this.body(c.target)
            const v = bodyVolume(s)
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
    }
  }

  /**
   * STEP or STL of the named features (default: all bodies) in one file.
   * models replaces part_* blocks with the vendor meshes (OBJ text by
   * part ref), sewn into faces.
   */
  async export(format: 'step' | 'stl' | '3mf', names: string[], models: Record<string, string> = {}): Promise<Blob> {
    if (!names.length) throw new Error('nothing to export: the model has no bodies')
    if (format !== 'step') {
      // Triangles: mesh bodies as they are, B-rep bodies tessellated finely.
      const objects = names.map((n) => {
        const c = this.cache.get(n)
        if (!c) throw new Error(`no feature "${n}"`)
        let mesh: TriMesh
        if (isMesh(c.shape)) mesh = c.shape.triMesh()
        else {
          const m = (c.shape as Shape3D).mesh({ tolerance: 0.01, angularTolerance: 0.1 })
          mesh = { positions: Float32Array.from(m.vertices), triangles: Uint32Array.from(m.triangles) }
        }
        const f = this.doc?.features.find((x) => x.name === n)
        const material = f?.material ? this.doc?.materials?.find((x) => x.name === f.material) : undefined
        return { name: n, mesh, color: material?.color ?? f?.color }
      })
      return format === 'stl' ? writeSTL(objects.map((o) => o.mesh)) : write3MF(objects)
    }
    const meshy = names.filter((n) => this.isMeshBody(n))
    if (meshy.length) throw new Error(`${meshy.join(', ')} ${meshy.length === 1 ? 'is a triangle mesh' : 'are triangle meshes'} (imported STL / 3MF): STEP holds B-rep solids; export them as STL or 3MF, or leave them out with names`)
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
      return compound.blobSTEP()
    } finally {
      compound.delete()
    }
  }

  /**
   * The slicer project a 3MF import came from, with some of its objects'
   * meshes replaced by built bodies: for each pair, the body's triangles
   * (with the paint that followed them) take the place of the 3MF object
   * that the import names. Everything else in the file stays.
   */
  async update3MF(doc: Doc, pairs: { body: string; object: string }[]): Promise<{ blob: Blob; file: string; replaced: string[]; also_changed: string[] }> {
    const urls = new Set<string>()
    const replace: { id: string; mesh: TriMesh }[] = []
    let file: ThreeMF | undefined
    const objectNames = new Map<string, string>()
    for (const pr of pairs) {
      const f = doc.features.find((x) => x.name === pr.object)
      if (!f || f.type !== 'import') throw new Error(`"${pr.object}" is not an import feature; give the import of the 3MF object to replace (e.g. "cover")`)
      const key = fetchKey(f.url)
      if (!/\.3mf$/i.test(key)) throw new Error(`"${pr.object}" imports ${f.url}, not a 3MF; write back works only into a 3MF (use export for STL)`)
      urls.add(key)
      if (urls.size > 1) throw new Error('all objects must come from the same 3MF file')
      const opened = this.threeMF.get(key)
      if (!opened || opened instanceof Error) throw new Error(`${key} is not open: build the design first`)
      file = opened
      const obj = pickObject(opened, decodeURIComponent(f.url.split('#')[1] ?? ''), key)
      const c = this.cache.get(pr.body)
      if (!c) throw new Error(`no body "${pr.body}"`)
      const mesh = isMesh(c.shape) ? c.shape.triMesh() : this.meshOf(pr.body).triMesh()
      replace.push({ id: obj.id, mesh })
      objectNames.set(obj.id, obj.name)
    }
    if (!file) throw new Error('nothing to write: give body/object pairs')
    const { blob, touched } = await update3MF(file.raw, replace)
    const asked = new Set(replace.map((r) => r.id))
    const name = (id: string) => `#${id} (${file!.objects.find((o) => o.id === id)?.name ?? '?'})`
    return { blob, file: [...urls][0], replaced: [...asked].map(name), also_changed: touched.filter((t) => !asked.has(t)).map(name) }
  }

  get parameters(): Map<string, number> {
    return this.params
  }
}

/** Drops points within tol of the outline (Ramer–Douglas–Peucker on a closed ring). */
function simplifyRing(ring: [number, number][], tol: number): [number, number][] {
  const n = ring.length
  if (n <= 4 || tol <= 0) return ring
  // Anchor the ring at its two far-apart points (corners, not a point mid-edge); simplify both open runs.
  const cx = ring.reduce((s, p) => s + p[0], 0) / n
  const cy = ring.reduce((s, p) => s + p[1], 0) / n
  let first = 0
  for (let i = 1; i < n; i++) if (Math.hypot(ring[i][0] - cx, ring[i][1] - cy) > Math.hypot(ring[first][0] - cx, ring[first][1] - cy)) first = i
  ring = [...ring.slice(first), ...ring.slice(0, first)]
  let split = 1
  const d0 = (i: number) => Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1])
  for (let i = 2; i < n; i++) if (d0(i) > d0(split)) split = i
  const keep = new Uint8Array(n)
  keep[0] = keep[split] = 1
  const pt = (i: number) => ring[i % n]
  const stack: [number, number][] = [[0, split], [split, n]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    const [ax, ay] = pt(a)
    const [bx, by] = pt(b)
    const len = Math.hypot(bx - ax, by - ay)
    let best = -1
    let far = tol
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pt(i)
      const e = len > 1e-12 ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len : Math.hypot(px - ax, py - ay)
      if (e > far) {
        far = e
        best = i
      }
    }
    if (best < 0) continue
    keep[best % n] = 1
    stack.push([a, best], [best, b])
  }
  return ring.filter((_, i) => keep[i])
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

/** The overlap of two solids: its volume and each separate piece's box and volume. */
function overlapRegions(a: Shape3D, b: Shape3D): { volume: number; regions: { box: [V3, V3]; volume: number }[] } {
  try {
    const i = (a.clone() as Shape3D).intersect(b.clone() as Shape3D) as Shape3D
    const volume = volumeOf(i)
    const regions: { box: [V3, V3]; volume: number }[] = []
    if (volume > 1e-6) {
      const solids = (i as unknown as { solids?: Shape3D[] }).solids ?? [i]
      for (const s of solids as Shape3D[]) {
        const v = volumeOf(s)
        if (v < 1e-6) continue
        const [lo, hi] = bboxOf(s)
        regions.push({ box: [r3(lo), r3(hi)], volume: round(v, 4) })
      }
      regions.sort((x, y) => y.volume - x.volume)
    }
    i.delete()
    return { volume, regions }
  } catch {
    return { volume: 0, regions: [] }
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

/** Axis and angle (degrees) of a unit quaternion x, y, z, w. */
function quatAxisAngle(q: [number, number, number, number]): { axis: V3; angle: number } {
  const w = Math.max(-1, Math.min(1, q[3]))
  const s = Math.sqrt(1 - w * w)
  if (s < 1e-12) return { axis: [0, 0, 1], angle: 0 }
  return { axis: [q[0] / s, q[1] / s, q[2] / s], angle: (2 * Math.acos(w) * 180) / Math.PI }
}
