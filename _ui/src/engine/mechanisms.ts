// Mechanisms besides gears: disc cams with a radial follower, external
// geneva drives and belt / chain loops. Each one is solved from the
// document like a gear (placement, sizes, warnings), gives the kernel its
// solid, and tells the motion plan how its bodies move:
//   cam      turns with its rotation; a follower joint slides by the lift
//   geneva   the drive turns with its angle; the wheel indexes 360/slots per turn
//   belt     the pulleys it names turn together, inversely to their diameters

import * as R from 'replicad'
import type { Shape3D } from 'replicad'

import type { Doc, Feature, Plane } from './doc'
import { evaluate, num } from './expr'
import { AXIS_DIRS, type AxisDir, axisAngleOf, angleIn, dirIn, type Frame, frameOf, type V3 } from './gears'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI
type Params = Map<string, number>
type P2 = [number, number]

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const r3 = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d

/** Turns a local solid (axis +Z, centered at the origin) by rot degrees, onto the frame, to center. */
function placeLocal(s: Shape3D, frame: Frame, center: V3, rot: number): Shape3D {
  if (rot) s = s.rotate(rot, [0, 0, 0], [0, 0, 1])
  const { k, angle } = axisAngleOf(frame)
  if (angle) s = s.rotate(angle * R2D, [0, 0, 0], k)
  if (center[0] || center[1] || center[2]) s = s.translate(center[0], center[1], center[2])
  return s
}

function polyline(pts: P2[]): R.Drawing {
  let pen = R.draw(pts[0])
  for (const p of pts.slice(1)) pen = pen.lineTo(p)
  return pen.close()
}

// ── Cam ─────────────────────────────────────────────────────────────────

type CamFeature = Extract<Feature, { type: 'cam' }>

export interface CamState {
  name: string
  center: V3
  axis: V3
  frame: Frame
  /** Degrees about the axis. */
  rotation: number
  baseR: number
  roller: number
  width: number
  /** Lift at each whole degree of cam angle, 0..359. */
  lift: number[]
  /** Follower angle in the cam plane, degrees. */
  followerAt: number
  /** Unit direction the follower slides along (outward). */
  followerDir: V3
  maxPressure: number
  warnings: string[]
}

const SAMPLES = 360

function solveCam(f: CamFeature, params: Params): CamState {
  const N = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, params, `${f.name}.${field}`, fb)
  const warnings: string[] = []
  const baseR = N(f.base_r, 'base_r')
  if (!(baseR > 0)) throw new Error('base_r (radius under the follower at zero lift) must be > 0')
  const width = N(f.width, 'width')
  if (!(width > 0)) throw new Error('width must be > 0')
  const roller = N(f.roller, 'roller', 0)
  if (roller < 0) throw new Error('roller radius must be ≥ 0 (0 for a knife-edge follower)')
  const lift: number[] = []
  for (let i = 0; i < SAMPLES; i++) {
    let v: number
    try {
      v = evaluate(f.lift, (n) => (n === 't' ? i : params.get(n)))
    } catch (e) {
      throw new Error(`lift = "${f.lift}": ${(e as Error).message}; write it in t (cam angle, degrees), e.g. "6*(1 - cos(t))/2"`)
    }
    if (!Number.isFinite(v)) throw new Error(`lift is not a number at t=${i}`)
    if (baseR + v <= 0.5) throw new Error(`lift ${v.toFixed(2)} at t=${i} reaches the cam center (base_r ${baseR}); raise base_r`)
    lift.push(v)
  }
  const end = evaluate(f.lift, (n) => (n === 't' ? 360 : params.get(n)))
  if (Math.abs(end - lift[0]) > 1e-6) warnings.push(`lift(360) = ${end.toFixed(3)} differs from lift(0) = ${lift[0].toFixed(3)}: the profile has a step; make lift periodic`)
  // Pressure angle of a radial follower: tan φ = (dL/dθ) / (r0 + L).
  let maxP = 0
  for (let i = 0; i < SAMPLES; i++) {
    const dl = ((lift[(i + 1) % SAMPLES] - lift[(i + SAMPLES - 1) % SAMPLES]) / 2) * R2D
    maxP = Math.max(maxP, Math.abs(Math.atan(dl / (baseR + roller + lift[i]))) * R2D)
  }
  if (maxP > 30) warnings.push(`pressure angle reaches ${maxP.toFixed(1)}° (over 30°): the follower jams; raise base_r or spread the rise over more degrees`)
  const frame = frameOf(AXIS_DIRS[(f.axis ?? 'Z') as AxisDir])
  const followerAt = N(f.follower_at, 'follower_at', 90)
  return {
    name: f.name,
    center: f.center ? ([0, 1, 2].map((i) => N(f.center![i], `center[${i}]`)) as V3) : [0, 0, 0],
    axis: frame.a,
    frame,
    rotation: N(f.rotation, 'rotation', 0),
    baseR,
    roller,
    width,
    lift,
    followerAt,
    followerDir: dirIn(frame, followerAt),
    maxPressure: maxP,
    warnings,
  }
}

export function camStates(doc: Doc, params: Params): Map<string, CamState | Error> {
  const out = new Map<string, CamState | Error>()
  for (const f of doc.features) {
    if (f.type !== 'cam') continue
    try {
      out.set(f.name, solveCam(f, params))
    } catch (e) {
      out.set(f.name, e as Error)
    }
  }
  return out
}

/** The cam profile in its own frame (axis +Z, angle 0 on +X). */
function camLocal(c: CamState, bore: number, what: string): Shape3D {
  const pitch: P2[] = c.lift.map((l, i) => {
    const r = c.baseR + c.roller + l
    return [r * Math.cos(i * D2R), r * Math.sin(i * D2R)]
  })
  let pts = pitch
  if (c.roller > 0) {
    // The cam surface is the pitch curve moved in by the roller along its normal.
    pts = pitch.map((p, i) => {
      const a = pitch[(i + SAMPLES - 1) % SAMPLES]
      const b = pitch[(i + 1) % SAMPLES]
      const tx = b[0] - a[0]
      const ty = b[1] - a[1]
      const l = Math.hypot(tx, ty) || 1
      return [p[0] - (ty / l) * c.roller, p[1] + (tx / l) * c.roller]
    })
    // Undercut: the inner offset loops back on itself where the pitch curve bends tighter than the roller.
    for (let i = 0; i < SAMPLES; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % SAMPLES]
      if (Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0]) < -1e-9 && Math.abs(Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0])) < Math.PI) {
        throw new Error(`${what}: the roller (r ${c.roller}) is larger than the profile's curvature near t=${i}: the cam is undercut; use a smaller roller or a larger base_r`)
      }
    }
  }
  if (bore && bore / 2 >= c.baseR - 0.5) throw new Error(`${what}: bore Ø${bore} leaves no material (base_r ${c.baseR})`)
  let d = R.drawPointsInterpolation([...pts, pts[0]], { tolerance: 1e-3 }, { closeShape: true })
  if (bore) d = d.cut(R.drawCircle(bore / 2))
  return d.sketchOnPlane('XY', -c.width / 2).extrude(c.width) as Shape3D
}

// ── Geneva ──────────────────────────────────────────────────────────────

type GenevaDrive = Extract<Feature, { type: 'geneva'; part: 'drive' }>

export interface GenevaState {
  /** The drive feature. */
  drive: string
  /** The wheel feature (empty until one is added). */
  wheel: string
  slots: number
  /** crank radius / center distance = sin(π/slots). */
  k: number
  distance: number
  crank: number
  wheelR: number
  pinD: number
  width: number
  lockR: number
  clearance: number
  center: V3
  wheelCenter: V3
  axis: V3
  frame: Frame
  /** Drive angle from the line of centers, degrees. */
  angle: number
  /** Local angle of the line of centers. */
  toward: number
  bore: number
  wheelBore: number
}

/** The wheel's turn (degrees, + about the axis) for a drive angle θ (degrees from the line of centers). */
export function genevaAngle(slots: number, k: number, theta: number): number {
  const q = Math.floor((theta + 180) / 360)
  const t = (theta - 360 * q) * D2R
  const alpha = Math.PI / 2 - Math.PI / slots
  const phi = Math.abs(t) <= alpha ? Math.atan2(k * Math.sin(t), 1 - k * Math.cos(t)) : Math.sign(t) * (Math.PI / slots)
  // The wheel turns against the drive.
  return -(phi + q * ((2 * Math.PI) / slots)) * R2D
}

export function genevaStates(doc: Doc, params: Params): Map<string, GenevaState | Error> {
  const out = new Map<string, GenevaState | Error>()
  for (const f of doc.features) {
    if (f.type !== 'geneva') continue
    if (f.part === 'wheel') {
      const g = out.get(f.drive)
      if (g && !(g instanceof Error)) {
        if (g.wheel) out.set(f.name, new Error(`drive "${f.drive}" already has the wheel "${g.wheel}"`))
        else {
          g.wheel = f.name
          g.wheelBore = num(f.bore, params, `${f.name}.bore`, 0)
        }
      }
      continue
    }
    try {
      out.set(f.name, solveGeneva(f, params))
    } catch (e) {
      out.set(f.name, e as Error)
    }
  }
  return out
}

function solveGeneva(f: GenevaDrive, params: Params): GenevaState {
  const N = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, params, `${f.name}.${field}`, fb)
  const slots = Math.round(N(f.slots, 'slots'))
  if (slots < 3 || slots > 18) throw new Error('slots must be 3..18 (4 and 6 are common)')
  const distance = N(f.distance, 'distance')
  if (!(distance > 0)) throw new Error('distance (between the drive and wheel axes) must be > 0')
  const pinD = N(f.pin_d, 'pin_d')
  const width = N(f.width, 'width')
  if (!(width > 0)) throw new Error('width must be > 0')
  const clearance = N(f.clearance, 'clearance', 0.2)
  const k = Math.sin(Math.PI / slots)
  const crank = distance * k
  const wheelR = Math.hypot(distance * Math.cos(Math.PI / slots), pinD / 2 + clearance)
  if (!(pinD > 0) || pinD > crank * 0.6) throw new Error(`pin_d must be > 0 and well under the crank radius ${crank.toFixed(2)} (try ${(crank * 0.2).toFixed(1)})`)
  // Locking disc: the wheel's concave arcs (this radius, centered at the
  // drive) must leave each arm tip at least a wall beside its slot.
  const sw = pinD + 2 * clearance
  const wall = Math.max(0.75 * pinD, 1.5)
  if ((sw / 2 + wall) / wheelR >= Math.sin(Math.PI / slots)) throw new Error(`the slots (${sw.toFixed(1)} wide) leave no arms on a ${slots}-slot wheel of r ${wheelR.toFixed(1)}; use a smaller pin, fewer slots or a larger distance`)
  const phi = Math.PI / slots - Math.asin((sw / 2 + wall) / wheelR)
  const lockR = Math.min(crank - pinD, Math.sqrt(distance ** 2 + wheelR ** 2 - 2 * distance * wheelR * Math.cos(phi)))
  const bore = N(f.bore, 'bore', 0)
  if (lockR <= bore / 2 + 1) throw new Error(`the locking disc (r ${lockR.toFixed(2)}) leaves no room for the bore Ø${bore}; use a larger distance or a smaller pin`)
  const slotIn = distance - crank - pinD / 2 - clearance
  if (slotIn < pinD) throw new Error(`the slots reach the wheel center; use fewer slots or a larger distance`)
  const frame = frameOf(AXIS_DIRS[(f.axis ?? 'Z') as AxisDir])
  const center: V3 = f.center ? ([0, 1, 2].map((i) => N(f.center![i], `center[${i}]`)) as V3) : [0, 0, 0]
  const toward = N(f.toward, 'toward', 0)
  return {
    drive: f.name,
    wheel: '',
    slots,
    k,
    distance,
    crank,
    wheelR,
    pinD,
    width,
    lockR,
    clearance,
    center,
    wheelCenter: add(center, scale(dirIn(frame, toward), distance)),
    axis: frame.a,
    frame,
    angle: N(f.angle, 'angle', 180),
    toward,
    bore,
    wheelBore: 0,
  }
}

/** Drive: locking disc with the crescent, crank plate under it, pin on +X. */
function genevaDriveLocal(g: GenevaState): Shape3D {
  const w = g.width
  const c = g.clearance
  let lock = R.drawCircle(g.lockR).cut(R.drawCircle(g.wheelR + c).translate(g.distance, 0))
  let plate = R.drawCircle(g.crank + g.pinD)
  if (g.bore) {
    lock = lock.cut(R.drawCircle(g.bore / 2))
    plate = plate.cut(R.drawCircle(g.bore / 2))
  }
  let s = lock.sketchOnPlane('XY', -w).extrude(1.5 * w) as Shape3D
  // The crank plate runs under the wheel with a gap.
  s = s.fuse(plate.sketchOnPlane('XY', -w).extrude(w / 2 - c) as Shape3D) as Shape3D
  s = s.fuse(R.makeCylinder(g.pinD / 2, w + w / 2, [g.crank, 0, -w], [0, 0, 1])) as Shape3D
  return s
}

/** Wheel: slot 0 on +X, locking arcs between the slots. */
function genevaWheelLocal(g: GenevaState): Shape3D {
  const c = g.clearance
  const sw = g.pinD + 2 * c
  const slotIn = g.distance - g.crank - g.pinD / 2 - c
  let d = R.drawCircle(g.wheelR)
  for (let i = 0; i < g.slots; i++) {
    const a = (i * 360) / g.slots
    const slot = R.drawRectangle(g.wheelR + 2 - slotIn - sw / 2, sw)
      .translate(slotIn + sw / 2 + (g.wheelR + 2 - slotIn - sw / 2) / 2, 0)
      .fuse(R.drawCircle(sw / 2).translate(slotIn + sw / 2, 0))
      .rotate(a, [0, 0])
    d = d.cut(slot)
    const arc = R.drawCircle(g.lockR + c).translate(g.distance * Math.cos((a + 180 / g.slots) * D2R), g.distance * Math.sin((a + 180 / g.slots) * D2R))
    d = d.cut(arc)
  }
  if (g.wheelBore) {
    if (g.wheelBore / 2 >= slotIn - 1) throw new Error(`wheel bore Ø${g.wheelBore} cuts into the slots`)
    d = d.cut(R.drawCircle(g.wheelBore / 2))
  }
  return d.sketchOnPlane('XY', -g.width / 2).extrude(g.width) as Shape3D
}

// ── Belt / chain ────────────────────────────────────────────────────────

type BeltFeature = Extract<Feature, { type: 'belt' }>

export interface BeltState {
  name: string
  plane: Plane
  offset: number
  normal: V3
  pulleys: { center: V3; at: P2; r: number; body?: string; wrap: number }[]
  thickness: number
  width: number
  /** Pitch length, mm. */
  length: number
  pitch?: number
  /** Links or teeth along the loop (length / pitch). */
  links?: number
  warnings: string[]
  /** Tangent points (pitch line) and arcs, in plane coordinates, for the solid. */
  path: { c: P2; r: number; from: number; to: number }[]
}

/** Plane axes u, v and u × v (the axis a counterclockwise turn in the plane is about). */
const PLANE_UV: Record<Plane, [V3, V3, V3]> = {
  XY: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  XZ: [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
  YZ: [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
}
/** Where a plane's offset points (an XZ sketch at offset o lies at y = o). */
const PLANE_AT: Record<Plane, V3> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] }

function solveBelt(f: BeltFeature, params: Params): BeltState {
  const N = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, params, `${f.name}.${field}`, fb)
  const warnings: string[] = []
  if (f.pulleys.length < 2) throw new Error('a belt needs at least 2 pulleys')
  const pitch = f.pitch !== undefined ? N(f.pitch, 'pitch') : undefined
  const thickness = N(f.thickness, 'thickness')
  const width = N(f.width, 'width')
  if (!(thickness > 0) || !(width > 0)) throw new Error('thickness and width must be > 0')
  const offset = N(f.offset, 'offset', 0)
  const [u, v, n] = PLANE_UV[f.plane]
  const ps = f.pulleys.map((p, i) => {
    const at: P2 = [N(p.at[0], `pulleys[${i}].at[0]`), N(p.at[1], `pulleys[${i}].at[1]`)]
    let r: number
    if (p.d !== undefined) r = N(p.d, `pulleys[${i}].d`) / 2
    else if (p.teeth !== undefined) {
      if (!pitch) throw new Error(`pulleys[${i}]: teeth needs the belt's pitch (e.g. 2 for GT2, 12.7 for #40 chain)`)
      r = pitch / (2 * Math.sin(Math.PI / Math.round(N(p.teeth, `pulleys[${i}].teeth`))))
    } else throw new Error(`pulleys[${i}]: give d (pitch diameter) or teeth`)
    if (!(r > 0)) throw new Error(`pulleys[${i}]: diameter must be > 0`)
    return { at, r, body: p.body }
  })
  // Run counterclockwise around the middle; every pulley must be on the outside.
  const mid: P2 = [ps.reduce((s, p) => s + p.at[0], 0) / ps.length, ps.reduce((s, p) => s + p.at[1], 0) / ps.length]
  ps.sort((a, b) => Math.atan2(a.at[1] - mid[1], a.at[0] - mid[0]) - Math.atan2(b.at[1] - mid[1], b.at[0] - mid[0]))
  const count = ps.length
  // Outer tangent from pulley i to i+1, on the right of the travel direction.
  const normals: P2[] = []
  for (let i = 0; i < count; i++) {
    const a = ps[i]
    const b = ps[(i + 1) % count]
    const dx = b.at[0] - a.at[0]
    const dy = b.at[1] - a.at[1]
    const L = Math.hypot(dx, dy)
    if (L < a.r + b.r + thickness) throw new Error(`pulleys at [${a.at}] and [${b.at}] overlap (centers ${L.toFixed(2)} apart, radii ${a.r.toFixed(2)} + ${b.r.toFixed(2)})`)
    const cos = (a.r - b.r) / L
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos))
    const t: P2 = [dx / L, dy / L]
    const right: P2 = [t[1], -t[0]]
    normals.push([cos * t[0] + sin * right[0], cos * t[1] + sin * right[1]])
  }
  let length = 0
  const path: BeltState['path'] = []
  const pulleys: BeltState['pulleys'] = []
  for (let i = 0; i < count; i++) {
    const p = ps[i]
    const nin = normals[(i + count - 1) % count]
    const nout = normals[i]
    const from = Math.atan2(nin[1], nin[0])
    let to = Math.atan2(nout[1], nout[0])
    while (to <= from) to += 2 * Math.PI
    const wrap = to - from
    if (wrap > 2 * Math.PI - 1e-6 || wrap < 1e-6) throw new Error(`pulley at [${p.at}] is inside the loop; a belt runs around the outside of every pulley (idlers inside are not supported)`)
    if (wrap * R2D < 120 && p.body) warnings.push(`the belt wraps only ${(wrap * R2D).toFixed(0)}° around the pulley at [${p.at}]; under ~120° it slips (timing belts skip teeth)`)
    path.push({ c: p.at, r: p.r, from, to })
    const nxt = ps[(i + 1) % count]
    const a: P2 = [p.at[0] + p.r * nout[0], p.at[1] + p.r * nout[1]]
    const b: P2 = [nxt.at[0] + nxt.r * nout[0], nxt.at[1] + nxt.r * nout[1]]
    length += wrap * p.r + Math.hypot(b[0] - a[0], b[1] - a[1])
    pulleys.push({ center: add(add(scale(u, p.at[0]), scale(v, p.at[1])), scale(PLANE_AT[f.plane], offset)), at: p.at, r: p.r, body: p.body, wrap: wrap * R2D })
  }
  const st: BeltState = { name: f.name, plane: f.plane, offset, normal: n, pulleys, thickness, width, length, warnings, path }
  if (pitch) {
    st.pitch = pitch
    st.links = length / pitch
    if (Math.abs(st.links - Math.round(st.links)) > 0.05) warnings.push(`the loop is ${st.links.toFixed(2)} pitches long; move a pulley to make it a whole number (${Math.round(st.links)} → length ${(Math.round(st.links) * pitch).toFixed(2)} mm)`)
  }
  return st
}

export function beltStates(doc: Doc, params: Params): Map<string, BeltState | Error> {
  const out = new Map<string, BeltState | Error>()
  for (const f of doc.features) {
    if (f.type !== 'belt') continue
    try {
      out.set(f.name, solveBelt(f, params))
    } catch (e) {
      out.set(f.name, e as Error)
    }
  }
  return out
}

/** The loop at distance e outside the pitch line. */
function beltLoop(b: BeltState, e: number): R.Drawing {
  const pt = (c: P2, r: number, a: number): P2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]
  const first = b.path[0]
  let pen = R.draw(pt(first.c, first.r + e, first.from))
  for (let i = 0; i < b.path.length; i++) {
    const s = b.path[i]
    const r = s.r + e
    pen = pen.threePointsArcTo(pt(s.c, r, s.to), pt(s.c, r, (s.from + s.to) / 2))
    const nx = b.path[(i + 1) % b.path.length]
    if (i < b.path.length - 1) pen = pen.lineTo(pt(nx.c, nx.r + e, nx.from))
  }
  return pen.close()
}

function beltShape(b: BeltState): Shape3D {
  const t = b.thickness / 2
  const ring = beltLoop(b, t).cut(beltLoop(b, -t))
  const flip = b.plane === 'XZ' ? -1 : 1
  return ring.sketchOnPlane(b.plane, (b.offset - b.width / 2) * flip).extrude(b.width * flip) as Shape3D
}

// ── Kernel entry points ─────────────────────────────────────────────────

/** States of every mechanism in the document. */
export interface Mechanisms {
  cams: Map<string, CamState | Error>
  genevas: Map<string, GenevaState | Error>
  belts: Map<string, BeltState | Error>
}

export function mechanismStates(doc: Doc, params: Params): Mechanisms {
  return { cams: camStates(doc, params), genevas: genevaStates(doc, params), belts: beltStates(doc, params) }
}

function genevaOf(m: Mechanisms, name: string): GenevaState {
  const direct = m.genevas.get(name)
  if (direct instanceof Error) throw direct
  if (direct) return direct
  for (const g of m.genevas.values()) if (!(g instanceof Error) && g.wheel === name) return g
  throw new Error('its drive failed or is missing; add the geneva drive first and fix it')
}

/** The solid of a cam, geneva or belt feature. */
export function mechanismShape(f: Feature, m: Mechanisms, params: Params, warnings: string[]): Shape3D {
  switch (f.type) {
    case 'cam': {
      const c = m.cams.get(f.name)
      if (!c) throw new Error('cam was not solved')
      if (c instanceof Error) throw c
      warnings.push(...c.warnings)
      const local = camLocal(c, num(f.bore, params, `${f.name}.bore`, 0), f.name)
      return placeLocal(local, c.frame, c.center, c.rotation)
    }
    case 'geneva': {
      const g = genevaOf(m, f.name)
      if (f.part === 'drive') return placeLocal(genevaDriveLocal(g), g.frame, g.center, g.toward + g.angle)
      // Slot 0 faces the drive at drive angle 0.
      return placeLocal(genevaWheelLocal(g), g.frame, g.wheelCenter, g.toward + 180 + genevaAngle(g.slots, g.k, g.angle))
    }
    case 'belt': {
      const b = m.belts.get(f.name)
      if (!b) throw new Error('belt was not solved')
      if (b instanceof Error) throw b
      warnings.push(...b.warnings)
      return beltShape(b)
    }
    default:
      throw new Error(`${f.type} is not a mechanism`)
  }
}

/** Mechanism facts for get_mechanisms. */
export function mechanismReport(m: Mechanisms): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const [name, c] of m.cams) {
    if (c instanceof Error) {
      out.push({ name, type: 'cam', error: c.message })
      continue
    }
    const lo = Math.min(...c.lift)
    const hi = Math.max(...c.lift)
    const t = (((c.followerAt - c.rotation) % 360) + 360) % 360
    const now = c.lift[Math.round(t) % SAMPLES]
    out.push({
      name,
      type: 'cam',
      center: c.center.map((v) => r3(v)),
      axis: c.axis,
      rotation: r3(c.rotation, 2),
      lift_range: [r3(lo), r3(hi)],
      stroke: r3(hi - lo),
      max_pressure_angle: r3(c.maxPressure, 1),
      follower_dir: c.followerDir.map((v) => r3(v, 4)),
      // Where the follower touches now: its tip for a knife edge, the roller center otherwise.
      follower_point: add(c.center, scale(c.followerDir, c.baseR + c.roller + now)).map((v) => r3(v)),
      lift_now: r3(now),
      ...(c.warnings.length ? { warnings: c.warnings } : {}),
    })
  }
  for (const [name, g] of m.genevas) {
    if (g instanceof Error) {
      out.push({ name, type: 'geneva', error: g.message })
      continue
    }
    out.push({
      name,
      type: 'geneva',
      wheel: g.wheel || undefined,
      slots: g.slots,
      crank_r: r3(g.crank),
      wheel_r: r3(g.wheelR),
      lock_r: r3(g.lockR),
      center: g.center.map((v) => r3(v)),
      wheel_center: g.wheelCenter.map((v) => r3(v)),
      index_per_turn: r3(360 / g.slots, 3),
      // The wheel moves during 180 − 360/slots degrees of each drive turn.
      moving_fraction: r3((180 - 360 / g.slots) / 360, 4),
      angle: r3(g.angle, 2),
      wheel_angle: r3(genevaAngle(g.slots, g.k, g.angle), 3),
      ...(g.wheel ? {} : { warnings: ['no wheel yet: add geneva part "wheel" with drive: "' + name + '"'] }),
    })
  }
  for (const [name, b] of m.belts) {
    if (b instanceof Error) {
      out.push({ name, type: 'belt', error: b.message })
      continue
    }
    const r0 = b.pulleys[0].r
    out.push({
      name,
      type: 'belt',
      length: r3(b.length, 2),
      ...(b.links !== undefined ? { links: r3(b.links, 2) } : {}),
      pulleys: b.pulleys.map((p) => ({ at: p.at, d: r3(2 * p.r), body: p.body, wrap: r3(p.wrap, 1), turns_per_turn_of_first: r3(r0 / p.r, 5) })),
      ...(b.warnings.length ? { warnings: b.warnings } : {}),
    })
  }
  return out
}

export { angleIn }
