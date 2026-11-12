// Mechanical features: holes for screws, bosses for heat-set inserts,
// threads, draft and snap-fit hooks. They build on faces picked by
// selector, so they follow the body when parameters change.

import * as R from 'replicad'
import type { FaceFinder, Shape3D } from 'replicad'

import type { Feature, Plane, Vec2E } from '../doc'
import { num } from '../expr'
import { insert, screw } from '../fasteners'
import type { Kernel } from '../kernel'
import { place } from './placement'
import { finderOf, selectElements } from './selectors'
import { bboxOf, volumeOf } from './shapes'
import type { SketchFrame, V3 } from './types'

type F<T extends Feature['type']> = Extract<Feature, { type: T }>

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]

/** World points of (u, v) positions on a face frame. */
function points(fr: SketchFrame, at: Vec2E[], params: Map<string, number>, what: string): V3[] {
  if (!at.length) throw new Error(`${what}: at needs at least one [u, v] position`)
  return at.map((p, i) => {
    const u = num(p[0], params, `${what}.at[${i}][0]`)
    const v = num(p[1], params, `${what}.at[${i}][1]`)
    return add(fr.origin, add(mul(fr.u, u), mul(fr.v, v)))
  })
}

/** A cylinder of radius r from p along dir for length (cylinder along any direction). */
function rod(p: V3, dir: V3, r: number, length: number): Shape3D {
  return R.makeCylinder(r, length, p, dir)
}

/** Cone frustum from p along dir: radius r1 at p, r2 at length (a revolved trapezoid, moved into place). */
function cone(p: V3, dir: V3, r1: number, r2: number, length: number): Shape3D {
  const half = R.draw([0, 0]).lineTo([r1, 0]).lineTo([r2, length]).lineTo([0, length]).close().sketchOnPlane('XZ') as R.Sketch
  let s = half.revolve([0, 0, 1], { origin: [0, 0, 0] }) as Shape3D
  // Turn +Z onto dir.
  const l = Math.hypot(...dir)
  const d: V3 = [dir[0] / l, dir[1] / l, dir[2] / l]
  const angle = (Math.acos(Math.max(-1, Math.min(1, d[2]))) * 180) / Math.PI
  if (angle > 1e-9) {
    const axis: V3 = Math.hypot(d[0], d[1]) < 1e-12 ? [1, 0, 0] : [-d[1], d[0], 0]
    s = s.rotate(angle, [0, 0, 0], axis)
  }
  return s.translate(p[0], p[1], p[2])
}

/** How far a body reaches below a face along -normal (for through holes), plus a margin. */
function throughDepth(k: Kernel, target: string, fr: SketchFrame): number {
  const [lo, hi] = bboxOf(k.shape(target))
  const corners: V3[] = []
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) corners.push([x, y, z])
  const depth = Math.max(...corners.map((c) => -((c[0] - fr.origin[0]) * fr.normal[0] + (c[1] - fr.origin[1]) * fr.normal[1] + (c[2] - fr.origin[2]) * fr.normal[2])))
  return Math.max(depth, 0) + 1
}

export function makeHole(k: Kernel, f: F<'hole'>, warnings: string[]): Shape3D {
  const p = k.parameters
  const n = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, p, `${f.name}.${field}`, fb)
  const kind = f.kind ?? 'plain'
  const fr = k.faceFrame(f.target, f.face, 0, f.name)
  const into = mul(fr.normal, -1)
  const s = f.size ? screw(f.size, f.name) : undefined
  const extra = n(f.clearance, 'clearance', 0)
  let d: number
  if (f.d !== undefined) d = n(f.d, 'd')
  else if (!s) throw new Error('give size (M2..M6) or d')
  else d = kind === 'tapped' ? s.tap : f.fit === 'close' ? s.close : s.normal
  d += extra
  if (!(d > 0)) throw new Error('the hole diameter must be > 0')
  if ((kind === 'counterbore' || kind === 'countersink') && !s) throw new Error(`a ${kind} needs size (M2..M6) for the head`)
  const through = throughDepth(k, f.target, fr)
  const depth = f.depth !== undefined ? n(f.depth, 'depth') : through
  if (!(depth > 0)) throw new Error('depth must be > 0')
  if (f.depth === undefined && kind === 'tapped') warnings.push('a tapped hole through the whole body: give depth for a blind hole')
  const tools: Shape3D[] = []
  // Tools start 0.5 mm above the face so the cut leaves no skin.
  const lift = 0.5
  for (const c of points(fr, f.at, p, f.name)) {
    const top = add(c, mul(fr.normal, lift))
    tools.push(rod(top, into, d / 2, depth + lift))
    if (kind === 'counterbore') tools.push(rod(top, into, (s!.head_d + 0.4 + extra) / 2, s!.head_h + 0.2 + lift))
    if (kind === 'countersink') {
      // 90° cone: from the head diameter at the face down to the hole.
      const rh = (s!.csk_d + extra) / 2
      tools.push(cone(top, into, rh + lift, d / 2, rh - d / 2 + lift))
    }
  }
  let body = k.shape(f.target)
  const before = volumeOf(body)
  // Per hole the drill and its head pocket overlap: fuse them first, then cut all holes in one pass.
  const holes = tools.length === 1 ? tools[0] : (tools.reduce((a, b) => a.fuse(b) as Shape3D) as Shape3D)
  body = body.cut(holes)
  if (Math.abs(volumeOf(body) - before) < 1e-6) warnings.push(`the holes removed no material: they are not on "${f.target}" (check at; the face center is the origin)`)
  return body
}

export function makeInsertBoss(k: Kernel, f: F<'insert_boss'>, warnings: string[]): Shape3D {
  const p = k.parameters
  const n = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, p, `${f.name}.${field}`, fb)
  const ins = insert(f.size, f.name)
  const fr = k.faceFrame(f.target, f.face, 0, f.name)
  const into = mul(fr.normal, -1)
  const height = n(f.height, 'height', 0)
  if (height < 0) throw new Error('height must be ≥ 0')
  const od = f.d !== undefined ? n(f.d, 'd') : ins.hole + 2 * ins.wall
  if (od < ins.hole + 2 * ins.wall - 1e-6) warnings.push(`the boss (Ø${od}) leaves less than ${ins.wall} mm of wall around the Ø${ins.hole} insert hole; it may crack when the insert goes in`)
  const depth = ins.length + 0.5
  const pts = points(fr, f.at, p, f.name)
  let body = k.shape(f.target)
  if (height > 0) {
    // Bosses overlap 0.3 mm into the face so they fuse.
    const bosses = pts.map((c) => rod(add(c, mul(fr.normal, -0.3)), fr.normal, od / 2, height + 0.3))
    body = body.fuse(bosses.length === 1 ? bosses[0] : (R.makeCompound(bosses) as Shape3D))
  }
  const holes = pts.map((c) => rod(add(c, mul(fr.normal, height + 0.5)), into, ins.hole / 2, depth + 0.5))
  const before = volumeOf(body)
  body = body.cut(holes.length === 1 ? holes[0] : (R.makeCompound(holes) as Shape3D))
  if (height === 0 && Math.abs(volumeOf(body) - before) < 1e-6) warnings.push(`the insert holes removed no material: they are not on "${f.target}"`)
  if (height < depth) {
    const thin = throughDepth(k, f.target, fr) - 1 + height < depth
    if (thin) warnings.push(`the insert hole (${depth.toFixed(1)} mm deep) goes through the part; make the boss taller or the part thicker`)
  }
  return body
}

/**
 * A metric thread (60° profile), modelled as a helical sweep. External:
 * the rod with its thread; internal: a tool to cut from a body (a threaded
 * hole). Printed threads under M3 rarely work; the clearance opens them up.
 */
export function makeThread(k: Kernel, f: F<'thread'>, warnings: string[]): Shape3D {
  const p = k.parameters
  const n = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, p, `${f.name}.${field}`, fb)
  const s = f.size ? screw(f.size, f.name) : undefined
  const d = f.d !== undefined ? n(f.d, 'd') : s?.d
  const pitch = f.pitch !== undefined ? n(f.pitch, 'pitch') : s?.pitch
  if (d === undefined || pitch === undefined) throw new Error('give size (M2..M6) or d and pitch')
  const length = n(f.length, 'length')
  if (!(d > 0 && pitch > 0 && length > 0)) throw new Error('d, pitch and length must be > 0')
  if (pitch > d / 3) throw new Error(`pitch ${pitch} is too coarse for d ${d}`)
  if (d < 3) warnings.push(`a ${d} mm thread is hard to print; use a heat-set insert or a tapped hole (hole kind: tapped) instead`)
  const internal = f.kind === 'internal'
  const gap = n(f.clearance, 'clearance', internal ? 0.15 : 0)
  // ISO basic profile: H = 0.866 p; thread depth 5/8 H on the major side.
  const H = 0.8660254 * pitch
  const depth = (5 / 8) * H
  const rMajor = d / 2 + (internal ? gap : -gap)
  const rMinor = rMajor - depth
  // Core cylinder and a triangular ridge swept along a helix on it.
  const core = R.makeCylinder(rMinor + 0.01, length, [0, 0, 0], [0, 0, 1])
  const half = (pitch * 7) / 16
  const prof = R.draw([rMinor - 0.01, -half])
    .lineTo([rMajor, -pitch / 16])
    .lineTo([rMajor, pitch / 16])
    .lineTo([rMinor - 0.01, half])
    .close()
    .sketchOnPlane('XZ') as R.Sketch
  const helix = R.makeHelix(pitch, length, rMinor, [0, 0, 0], [0, 0, 1])
  let ridge: Shape3D
  try {
    ridge = R.genericSweep(prof.wire, helix, { frenet: true }) as Shape3D
  } catch {
    throw new Error('OpenCascade could not sweep the thread; try a larger pitch or a shorter length')
  }
  let solid = core.fuse(ridge) as Shape3D
  // Trim the ends flat.
  const trim = R.makeCylinder(rMajor + pitch, length, [0, 0, 0], [0, 0, 1])
  solid = solid.intersect(trim) as Shape3D
  const axis = f.axis ?? 'Z'
  if (axis === 'X') solid = solid.rotate(90, [0, 0, 0], [0, 1, 0])
  if (axis === 'Y') solid = solid.rotate(-90, [0, 0, 0], [1, 0, 0])
  return place(solid, f, p, f.name)
}

export function makeDraft(k: Kernel, f: F<'draft'>): Shape3D {
  const p = k.parameters
  const angle = num(f.angle, p, `${f.name}.angle`)
  if (!angle || Math.abs(angle) >= 45) throw new Error('angle must be non-zero and under 45 degrees')
  const s = k.shape(f.target)
  const faces = selectElements(s, f.faces, true, p, `${f.name}.faces`)
  if (!faces.length) throw new Error(`the faces selector matched no face of "${f.target}"; try list_faces`)
  const plane: Plane = f.plane ?? 'XY'
  const off = num(f.offset, p, `${f.name}.offset`, 0)
  const origin: V3 = plane === 'XY' ? [0, 0, off] : plane === 'XZ' ? [0, off, 0] : [off, 0, 0]
  try {
    return s.draft(angle, finderOf<FaceFinder>(faces), R.makePlane(plane, origin))
  } catch (e) {
    throw new Error(`OpenCascade could not draft these faces (${e instanceof Error && e.message ? e.message : 'no detail'}): draft only faces that cross the neutral plane or meet it, before fillets and shells`)
  }
}

/** Hook sizes after defaults, shared by the hook and its window. */
function hookSizes(k: Kernel, f: F<'snap_fit'>) {
  const p = k.parameters
  const n = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, p, `${f.name}.${field}`, fb)
  const thickness = n(f.thickness, 'thickness', 1.6)
  const length = n(f.length, 'length', 10)
  const width = n(f.width, 'width', 6)
  const ctch = n(f.catch, 'catch', 1)
  const catchLength = n(f.catch_length, 'catch_length', 2)
  if (!(thickness > 0 && length > 0 && width > 0 && ctch > 0 && catchLength > 0)) throw new Error('length, width, thickness, catch and catch_length must be > 0')
  return { thickness, length, width, ctch, catchLength }
}

/**
 * A cantilever snap-fit hook standing on z = 0: beam along +Z, the catch
 * sticking out on +X at the top with a 30° lead-in. Move it into place with
 * translate/rotate and union it with the part.
 */
export function makeSnapFit(k: Kernel, f: F<'snap_fit'>, warnings: string[]): Shape3D {
  const p = k.parameters
  if (f.part === 'window') {
    if (!f.hook) throw new Error('a window needs hook: the snap_fit hook it takes')
    const h = k.doc!.features.find((x) => x.name === f.hook)
    if (!h || h.type !== 'snap_fit' || h.part !== 'hook') throw new Error(`"${f.hook}" is not a snap_fit hook`)
    const { width, ctch, catchLength, thickness, length } = hookSizes(k, h)
    const gap = num(f.clearance, p, `${f.name}.clearance`, 0.3)
    const wall = num(f.wall, p, `${f.name}.wall`, 2)
    // The opening the catch drops into, at the hook's catch height, through a wall facing -X.
    const w = width + 2 * gap
    const hgt = catchLength + 2 * gap
    const box = R.makeBaseBox(wall + thickness + ctch + 2, w, hgt).translate(thickness + ctch - (wall + thickness + ctch + 2) / 2 + 1, 0, length - catchLength - gap)
    return place(box as Shape3D, h, p, f.name)
  }
  const { thickness, length, width, ctch, catchLength } = hookSizes(k, f)
  const strain = (1.5 * thickness * ctch) / (length * length)
  if (strain > 0.03) warnings.push(`bending strain about ${(strain * 100).toFixed(1)}% at full deflection; PLA cracks above ~2-3%: make the beam longer or thinner, or the catch smaller`)
  const beam = R.makeBaseBox(thickness, width, length).translate(thickness / 2, 0, 0)
  // Catch: a wedge on +X, flat underside (holds), 30° lead-in on top.
  const lead = ctch / Math.tan((30 * Math.PI) / 180)
  const top = Math.min(catchLength, length)
  const wedge = R.draw([thickness - 0.01, length - top])
    .lineTo([thickness + ctch, length - top])
    .lineTo([thickness + ctch, length - Math.max(0, top - Math.min(lead, top))])
    .lineTo([thickness - 0.01, length])
    .close()
    // replicad's XZ normal is -Y: the plane at y = -width/2 extruded by width spans -width/2..width/2.
    .sketchOnPlane('XZ', width / 2)
    .extrude(-width) as Shape3D
  return place(beam.fuse(wedge) as Shape3D, f, p, f.name)
}
