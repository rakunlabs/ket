// Gears: involute spur, helical and herringbone gears, internal (ring)
// gears, racks, worms and straight bevel gears, and the placement of gears
// that mesh. A gear that meshes with (or shares a shaft with) an earlier
// gear gets its center, axis and rotation phase solved from it, so a whole
// train turns from one parameter: the first gear's rotation. Formulas follow
// KHK, "Calculation of Gear Dimensions" (spur, helical, internal, rack,
// cylindrical worm pair, straight bevel).

import * as R from 'replicad'
import type { Shape3D } from 'replicad'

import type { Doc, Feature } from './doc'
import { num } from './expr'

export type V3 = [number, number, number]
export type GearFeature = Extract<Feature, { type: 'gear' }>
export type GearKind = GearFeature['kind']
export type AxisDir = 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

// ── Vectors and frames ─────────────────────────────────────────────────

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
const unit = (a: V3): V3 => scale(a, 1 / (len(a) || 1))

export const AXIS_DIRS: Record<AxisDir, V3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1], '-X': [-1, 0, 0], '-Y': [0, -1, 0], '-Z': [0, 0, -1] }

/** Rotates v about unit axis k by angle (radians), Rodrigues. */
function rodrigues(v: V3, k: V3, angle: number): V3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)))
}

/** A right-handed frame: a along the gear axis, u the direction of angle 0. */
export interface Frame {
  u: V3
  v: V3
  a: V3
}

/** The image of the XYZ frame under the shortest rotation that takes +Z to a. */
export function frameOf(a: V3): Frame {
  a = unit(a)
  let k: V3 = [1, 0, 0]
  let angle = 0
  if (a[2] < -1 + 1e-12) angle = Math.PI
  else if (a[2] < 1 - 1e-12) {
    k = unit(cross([0, 0, 1], a))
    angle = Math.acos(Math.max(-1, Math.min(1, a[2])))
  }
  return { u: rodrigues([1, 0, 0], k, angle), v: rodrigues([0, 1, 0], k, angle), a }
}

/** Axis and angle (radians) of the rotation taking X, Y, Z to u, v, a. */
export function axisAngleOf(f: Frame): { k: V3; angle: number } {
  const m = [
    [f.u[0], f.v[0], f.a[0]],
    [f.u[1], f.v[1], f.a[1]],
    [f.u[2], f.v[2], f.a[2]],
  ]
  const angle = Math.acos(Math.max(-1, Math.min(1, (m[0][0] + m[1][1] + m[2][2] - 1) / 2)))
  if (angle < 1e-9) return { k: [0, 0, 1], angle: 0 }
  if (Math.PI - angle < 1e-6) {
    const i = m[0][0] >= m[1][1] && m[0][0] >= m[2][2] ? 0 : m[1][1] >= m[2][2] ? 1 : 2
    return { k: unit([(m[0][i] + (i === 0 ? 1 : 0)) / 2, (m[1][i] + (i === 1 ? 1 : 0)) / 2, (m[2][i] + (i === 2 ? 1 : 0)) / 2]), angle }
  }
  return { k: unit([m[2][1] - m[1][2], m[0][2] - m[2][0], m[1][0] - m[0][1]]), angle }
}

/** Angle (degrees) of a direction in a frame's (u, v) plane. */
export const angleIn = (f: Frame, d: V3) => Math.atan2(dot(d, f.v), dot(d, f.u)) * R2D
export const dirIn = (f: Frame, deg: number): V3 => add(scale(f.u, Math.cos(deg * D2R)), scale(f.v, Math.sin(deg * D2R)))

// ── Gear state: dimensions and placement ───────────────────────────────

export interface GearState {
  name: string
  kind: GearKind
  /** Teeth (starts for a worm). */
  z: number
  /** Module as given: normal module, or axial for a worm (and for its wheel). */
  m: number
  /** Normal module used for the tooth profile. */
  mn: number
  /** Normal pressure angle, degrees. */
  alpha: number
  /** Helix angle, degrees, + right hand. A worm's value is its lead angle. */
  helix: number
  shift: number
  backlash: number
  /** Face width along the axis (across the rack for racks). */
  width: number
  /** Length of a worm or rack. */
  length: number
  rp: number
  rb: number
  ra: number
  rf: number
  /** Transverse pressure angle, radians. */
  alphaT: number
  /** Mid-face center; back face for bevels; middle of the pitch line for racks. */
  center: V3
  frame: Frame
  /** Degrees about the axis (0 for racks). */
  rotation: number
  /** Racks: travel along frame.u, mm. */
  travel: number
  cone?: number
  lead?: number
  partner?: string
  relation?: 'mesh' | 'coaxial'
  /** Turns (racks: mm) per turn of the train's first gear. */
  ratio: number
  /** Rotation of the train's first gear, degrees (its input). */
  input: number
  warnings: string[]
}

export class GearError extends Error {}

type Params = Map<string, number>
const inv = (a: number) => Math.tan(a) - a

/** Resolves every gear in document order; a gear may follow any gear before it. */
export function gearStates(doc: Doc, params: Params): Map<string, GearState | GearError> {
  const out = new Map<string, GearState | GearError>()
  for (const f of doc.features) {
    if (f.type !== 'gear') continue
    try {
      out.set(f.name, solveGear(f, params, out))
    } catch (e) {
      out.set(f.name, e instanceof GearError ? e : new GearError((e as Error).message))
    }
  }
  return out
}

/**
 * The smallest profile shift that avoids undercut: x = (zmin − zv)/zmin with
 * zmin = 2/sin²α and zv the virtual teeth (BOSL2 auto_profile_shift).
 */
function autoShift(kind: GearKind, f: GearFeature, params: Params): number {
  if (kind !== 'spur' && kind !== 'helical' && kind !== 'herringbone') return 0
  const z = Math.round(num(f.teeth, params, `${f.name}.teeth`))
  const alpha = num(f.pressure_angle, params, `${f.name}.pressure_angle`, 20) * D2R
  const helix = Math.abs(num(f.helix, params, `${f.name}.helix`, kind === 'spur' ? 0 : 20)) * D2R
  const zv = z / Math.cos(helix) ** 3
  const zmin = 2 / Math.sin(alpha) ** 2
  return zv >= zmin ? 0 : Math.ceil(((zmin - zv) / zmin) * 1000) / 1000
}

function solveGear(f: GearFeature, params: Params, done: Map<string, GearState | GearError>): GearState {
  const N = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, params, `${f.name}.${field}`, fb)
  const V = (v: unknown[] | undefined, field: string): V3 | undefined => (v ? ([0, 1, 2].map((i) => N(v[i] as never, `${field}[${i}]`)) as V3) : undefined)
  const warnings: string[] = []
  const kind = f.kind
  const z = kind === 'rack' && f.teeth === undefined ? 1 : Math.round(N(f.teeth, 'teeth', NaN))
  if (!Number.isFinite(z)) throw new GearError('teeth is required (starts for a worm)')
  const m = N(f.module, 'module')
  if (!(m > 0)) throw new GearError('module must be > 0 (tooth size in mm: pitch diameter = module × teeth)')
  if (kind === 'worm' ? z < 1 || z > 6 : kind !== 'rack' && z < 5) throw new GearError(kind === 'worm' ? 'a worm has 1 to 6 starts (teeth)' : 'a gear needs at least 5 teeth')
  if (z > 300) throw new GearError('at most 300 teeth')
  const alpha = N(f.pressure_angle, 'pressure_angle', 20)
  if (alpha < 14 || alpha > 30) throw new GearError('pressure_angle must be 14..30 degrees (20 is standard)')
  const shift = f.profile_shift === 'auto' ? autoShift(kind, f, params) : N(f.profile_shift as never, 'profile_shift', 0)
  if (Math.abs(shift) > 0.8) throw new GearError('profile_shift must be -0.8..0.8')
  // Bevel teeth are tapered transverse profiles (not spherical involutes): give them more play.
  const backlash = N(f.backlash, 'backlash', kind === 'bevel' ? Math.min(0.1 * m + 0.05, 0.5) : Math.min(0.04 * m + 0.03, 0.3))
  if (backlash < 0 || backlash > m) throw new GearError('backlash must be 0..module mm')
  const width = N(f.width, 'width', kind === 'rack' ? 8 * m : kind === 'worm' ? 0 : NaN)
  if (kind !== 'worm' && !(width > 0)) throw new GearError('width (face width along the axis; across the rack) must be > 0')
  const length = kind === 'worm' || kind === 'rack' ? N(f.length, 'length', NaN) : 0
  if ((kind === 'worm' || kind === 'rack') && !(length > 0)) throw new GearError(`length (along the ${kind}) must be > 0`)

  let helix = N(f.helix, 'helix', kind === 'helical' || kind === 'herringbone' ? 20 : 0)
  if (kind === 'helical' || kind === 'herringbone') {
    if (Math.abs(helix) < 1 || Math.abs(helix) > 45) throw new GearError('helix must be 1..45 degrees (+ right hand, − left hand)')
  } else if (f.helix !== undefined && kind !== 'internal') throw new GearError(`helix does not apply to a ${kind}; use kind "helical"`)

  // Partner.
  if (f.mesh && f.coaxial) throw new GearError('use mesh or coaxial, not both')
  const ref = f.mesh?.with ?? f.coaxial?.with
  let P: GearState | undefined
  if (ref) {
    const p = done.get(ref)
    if (!p) throw new GearError(`"${ref}" is not a gear defined before "${f.name}"; add the gear it ${f.mesh ? 'meshes with' : 'shares a shaft with'} first`)
    if (p instanceof GearError) throw new GearError(`"${ref}" failed, so this gear cannot be placed: ${p.message}`)
    P = p
    if (f.center || f.rotation !== undefined || f.axis) warnings.push(`center, axis and rotation come from ${f.mesh ? 'the mesh' : 'the shaft'} with "${ref}"; the given values are ignored`)
  }

  // Hands follow the partner unless given.
  if (f.mesh && P) {
    const ext = (k: GearKind) => k === 'spur' || k === 'helical' || k === 'herringbone'
    if (P.kind === 'worm') {
      if (kind !== 'spur' && kind !== 'helical') throw new GearError('a worm drives a worm wheel: kind "helical" (or "spur"; its helix is set from the worm)')
      if (f.helix !== undefined && Math.abs(helix - P.helix) > 0.5) warnings.push(`helix ${helix}° does not match the worm's lead angle ${P.helix.toFixed(3)}°; it will not mesh cleanly`)
      if (f.helix === undefined) helix = P.helix
    } else if (ext(kind) && ext(P.kind)) {
      if (f.helix === undefined) helix = -P.helix
      else if (Math.abs(helix + P.helix) > 0.01) throw new GearError(`external gears mesh with opposite hands: "${P.name}" has helix ${P.helix}°, so this one needs ${-P.helix}°`)
      if (kind === 'spur' && helix) throw new GearError(`"${P.name}" is helical: use kind "helical" for its mate`)
      if (P.kind === 'herringbone' && kind !== 'herringbone') throw new GearError('a herringbone gear meshes with another herringbone gear')
      if (kind === 'herringbone' && P.kind !== 'herringbone') throw new GearError('a herringbone gear meshes with another herringbone gear')
    } else if (kind === 'internal' || P.kind === 'internal') {
      if (f.helix === undefined) helix = P.helix
      else if (Math.abs(helix - P.helix) > 0.01) throw new GearError(`an internal gear and its pinion have the same hand: use helix ${P.helix}°`)
    }
  }

  // Dimensions in the transverse plane.
  let mn = m
  let rp: number
  let alphaT: number
  let lead: number | undefined
  let cone: number | undefined
  if (kind === 'worm') {
    const d1 = N(f.diameter, 'diameter', Math.max(8 * m, 4 * m + 6))
    if (d1 < 4 * m) throw new GearError(`diameter ${d1} is too small for module ${m}; use at least ${4 * m}`)
    rp = d1 / 2
    lead = Math.PI * m * z
    const gamma = Math.atan(lead / (Math.PI * d1))
    const hand = f.hand === 'left' ? -1 : 1
    helix = hand * gamma * R2D
    const alphaN = Math.atan(Math.tan(alpha * D2R) * Math.cos(gamma))
    alphaT = Math.atan(Math.tan(alphaN) / Math.sin(gamma))
    if (gamma * R2D > 25) warnings.push(`lead angle ${(gamma * R2D).toFixed(1)}° is steep; the drive is not self-locking and needs a wheel with that helix`)
    else if (gamma * R2D < 5) warnings.push(`lead angle ${(gamma * R2D).toFixed(1)}° (below ~5°): self-locking, the wheel cannot drive the worm`)
  } else {
    if (P?.kind === 'worm' && f.mesh) mn = m * Math.cos(Math.abs(helix) * D2R)
    const beta = Math.abs(helix) * D2R
    const mt = mn / Math.cos(beta)
    rp = (mt * z) / 2
    alphaT = Math.atan(Math.tan(alpha * D2R) / Math.cos(beta))
    if (kind === 'bevel') {
      const pairZ = f.pair_teeth !== undefined ? Math.round(N(f.pair_teeth, 'pair_teeth')) : P?.kind === 'bevel' && f.mesh ? P.z : undefined
      if (pairZ === undefined && f.cone_angle === undefined) throw new GearError('a bevel gear needs pair_teeth (the teeth of its mate, for a 90° pair) or cone_angle')
      cone = f.cone_angle !== undefined ? N(f.cone_angle, 'cone_angle') : Math.atan(z / pairZ!) * R2D
      if (!(cone > 5 && cone < 85)) throw new GearError('the pitch cone angle must be 5..85 degrees')
    }
  }
  const rb = rp * Math.cos(alphaT)
  const ra = kind === 'worm' ? rp + m : rp + mn * (1 + shift)
  const rf = kind === 'worm' ? rp - 1.25 * m : rp - mn * (1.25 - shift)
  if (rf <= 0.3 * rp && kind !== 'internal' && kind !== 'rack') throw new GearError('the tooth roots reach the center; use more teeth or a smaller module')

  // Placement.
  let center: V3 = V(f.center as never, 'center') ?? [0, 0, 0]
  let frame = frameOf(AXIS_DIRS[(f.axis ?? 'Z') as AxisDir])
  let rotation = N(f.rotation, 'rotation', 0)
  let travel = N(f.travel, 'travel', 0)
  let relation: GearState['relation']
  let ratio = 1

  if (f.mesh && P) {
    relation = 'mesh'
    const axial = P.kind === 'worm' || kind === 'worm'
    if (!axial && Math.abs(P.mn - mn) > 1e-9) throw new GearError(`module ${m} does not match "${P.name}" (module ${P.m}); meshing gears share one module`)
    if (axial && Math.abs(P.m - m) > 1e-9) throw new GearError(`module ${m} does not match the worm pair's axial module ${P.m}`)
    if (Math.abs(P.alpha - alpha) > 1e-9) throw new GearError(`pressure_angle ${alpha} does not match "${P.name}" (${P.alpha})`)
    const toward = V(f.mesh.toward as never, 'mesh.toward')
    const side = (fr: Frame): { dir: V3; theta: number } => {
      if (toward) {
        const d = add(toward, scale(fr.a, -dot(toward, fr.a)))
        if (len(d) < 1e-9) throw new GearError('mesh.toward runs along the partner axis; give a direction across it')
        const dir = unit(d)
        return { dir, theta: angleIn(fr, dir) }
      }
      const theta = N(f.mesh!.angle, 'mesh.angle', 0)
      return { dir: dirIn(fr, theta), theta }
    }
    const roll = (contactP: number) => ((P.rotation - contactP) * P.z) / z

    if (kind === 'rack') {
      if (P.kind !== 'spur') throw new GearError(`a rack meshes with a spur gear, not a ${P.kind}`)
      const { dir, theta } = side(P.frame)
      center = add(P.center, scale(dir, P.rp + P.shift * m))
      // Right-handed: u × v = a. A positive pinion turn moves the pitch point along −u.
      frame = { u: cross(dir, P.frame.a), v: dir, a: P.frame.a }
      // A space faces the pinion tooth at the contact point. Only the part of
      // the pinion's rotation that does not follow the train's input may be
      // reduced by whole pitches, so the rack rests near the pinion and still
      // moves continuously with the input.
      const p = Math.PI * m
      const fixed = P.rotation - P.ratio * P.input
      let rest = theta * D2R * P.rp + p / 2 - fixed * D2R * P.rp
      rest -= Math.round(rest / p) * p
      travel = rest - P.ratio * P.input * D2R * P.rp
      rotation = 0
      ratio = -P.ratio * 2 * Math.PI * P.rp
    } else if (P.kind === 'rack') {
      throw new GearError(`gears do not mesh onto a rack; give the rack mesh: { with: "${f.name}" } instead`)
    } else if (axial) {
      if (kind === 'worm' && P.kind === 'worm') throw new GearError('two worms do not mesh')
      if (kind === 'worm' && P.kind !== 'helical' && P.kind !== 'spur') throw new GearError('a worm meshes with a worm wheel (helical)')
      const wormRp = kind === 'worm' ? rp : P.rp
      const wheelRp = kind === 'worm' ? P.rp : rp
      const wormLead = kind === 'worm' ? lead! : P.lead!
      const hand = (kind === 'worm' ? helix : P.helix) >= 0 ? 1 : -1
      const kappa = (2 * Math.PI * hand) / wormLead
      const pitch = Math.PI * m
      if (kind === 'worm') {
        if (Math.abs(Math.abs(P.helix) - Math.abs(helix)) > 0.5 || Math.sign(P.helix) !== Math.sign(helix))
          warnings.push(`the wheel "${P.name}" needs helix ${helix.toFixed(3)}° (this worm's lead angle, same hand); it has ${P.helix}°`)
        const { dir: dp, theta: psi } = side(P.frame)
        center = add(P.center, scale(dp, wormRp + wheelRp))
        frame = frameOf(cross(P.frame.a, dp))
        const phi = angleIn(frame, scale(dp, -1))
        rotation = (phi * D2R - kappa * (wheelRp * (P.rotation - psi) * D2R + pitch / 2)) * R2D
        ratio = (-P.ratio * P.z) / z
      } else {
        const { dir, theta: phi } = side(P.frame)
        center = add(P.center, scale(dir, wormRp + wheelRp))
        frame = frameOf(cross(P.frame.a, dir))
        const psi = angleIn(frame, scale(dir, -1))
        rotation = psi + ((((phi - P.rotation) * D2R) / kappa - pitch / 2) / wheelRp) * R2D
        ratio = (-P.ratio * P.z) / z
      }
    } else if (kind === 'bevel' || P.kind === 'bevel') {
      if (kind !== 'bevel' || P.kind !== 'bevel') throw new GearError('a bevel gear meshes with another bevel gear')
      if (Math.abs(cone! + P.cone! - 90) > 0.5) throw new GearError(`the pitch cones add up to ${(cone! + P.cone!).toFixed(2)}°; only 90° bevel pairs are supported: set pair_teeth on each to the other's teeth`)
      const { dir, theta } = side(P.frame)
      const apex = add(P.center, scale(P.frame.a, P.rp / Math.tan(P.cone! * D2R)))
      frame = frameOf(scale(dir, -1))
      center = add(apex, scale(dir, rp / Math.tan(cone! * D2R)))
      const contact = angleIn(frame, scale(P.frame.a, -1))
      rotation = contact + 180 / z - roll(theta)
      ratio = (-P.ratio * P.z) / z
    } else if (kind === 'internal' || P.kind === 'internal') {
      if (kind === 'internal' && P.kind === 'internal') throw new GearError('two internal gears do not mesh; mesh a pinion inside the ring')
      const ringZ = kind === 'internal' ? z : P.z
      const pinZ = kind === 'internal' ? P.z : z
      if (ringZ - pinZ < 10) throw new GearError(`the ring needs at least 10 teeth more than its pinion (has ${ringZ} vs ${pinZ}), or their tips collide`)
      const { dir, theta } = side(P.frame)
      frame = P.frame
      const ringRp = kind === 'internal' ? rp : P.rp
      const pinRp = kind === 'internal' ? P.rp : rp
      center = add(P.center, scale(dir, ringRp - pinRp))
      const c = kind === 'internal' ? theta + 180 : theta
      rotation = c + roll(c)
      ratio = (P.ratio * P.z) / z
    } else {
      const { dir, theta } = side(P.frame)
      frame = P.frame
      // Profile-shifted pair: the exact working center distance (KHK §4.2):
      // inv αw = 2·tanα·(x1+x2)/(z1+z2) + inv α, a = (r1+r2)·cosα/cosαw.
      let distance = P.rp + rp
      const xs = P.shift + shift
      if (xs) {
        const at = alphaT
        const invW = (2 * Math.tan(alpha * D2R) * xs) / (P.z + z) + inv(at)
        let aw = at
        for (let i = 0; i < 40; i++) aw -= (inv(aw) - invW) / Math.tan(aw) ** 2
        distance = ((P.rp + rp) * Math.cos(at)) / Math.cos(aw)
      }
      center = add(P.center, scale(dir, distance))
      rotation = theta + 180 + 180 / z - roll(theta)
      ratio = (-P.ratio * P.z) / z
    }
  } else if (f.coaxial && P) {
    relation = 'coaxial'
    if (P.kind === 'rack') throw new GearError('a rack has no shaft to share')
    if (kind === 'rack') throw new GearError('a rack cannot be on a shaft')
    frame = P.frame
    center = add(P.center, scale(P.frame.a, N(f.coaxial.offset, 'coaxial.offset', 0)))
    rotation = P.rotation + N(f.coaxial.phase, 'coaxial.phase', 0)
    ratio = P.ratio
  }

  if (kind === 'spur' || kind === 'helical' || kind === 'herringbone' || kind === 'bevel') {
    const zv = kind === 'bevel' ? z / Math.cos(cone! * D2R) : z / Math.cos(Math.abs(helix) * D2R) ** 3
    const zmin = 2 / Math.sin(alpha * D2R) ** 2
    if (zv < zmin && shift < (zmin - zv) / zmin - 1e-9)
      warnings.push(`${z} teeth at ${alpha}° are undercut (fewer than ${Math.ceil(zmin)}): thin roots; use profile_shift ≥ ${((zmin - zv) / zmin).toFixed(2)} or more teeth`)
  }

  return {
    name: f.name,
    kind,
    z,
    m,
    mn,
    alpha,
    helix,
    shift,
    backlash,
    width,
    length,
    rp,
    rb,
    ra,
    rf,
    alphaT,
    center,
    frame,
    rotation: kind === 'rack' ? 0 : rotation,
    travel,
    cone,
    lead,
    partner: P?.name,
    relation,
    ratio,
    input: P ? P.input : kind === 'rack' ? travel : rotation,
    warnings,
  }
}

// ── Profiles and solids ────────────────────────────────────────────────

type P2 = [number, number]
const polar = (r: number, a: number): P2 => [r * Math.cos(a), r * Math.sin(a)]
const rot2 = (p: P2, a: number): P2 => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)]

/**
 * The closed outline of z involute teeth, tooth 0 centered on +X; half is
 * the half angular tooth thickness at rp. Flanks are cubic Béziers through
 * Hermite samples of the involute, so they are smooth and exact enough.
 */
function toothOutline(z: number, rp: number, rb: number, ra: number, rf: number, alphaT: number, half: number, what: string): R.Drawing {
  const psiB = half + inv(alphaT)
  const psiAt = (r: number) => psiB - inv(Math.acos(Math.min(1, rb / r)))
  const start = Math.max(rf, rb)
  let tip = ra
  const minTip = 0.04 / z
  if (psiAt(ra) < minTip) {
    let lo = start
    let hi = ra
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2
      if (psiAt(mid) > minTip) lo = mid
      else hi = mid
    }
    tip = lo
  }
  if (tip <= start + 1e-6) throw new Error(`${what}: the teeth have no involute flank; use a smaller pressure angle, fewer starts or a larger diameter`)
  const step = (2 * Math.PI) / z
  const psiRoot = psiAt(start)
  if (2 * psiRoot >= step * 0.98) throw new Error(`${what}: the tooth roots overlap; increase backlash or reduce profile_shift`)

  const tOf = (r: number) => Math.sqrt(Math.max(0, (r / rb) ** 2 - 1))
  const t0 = tOf(start)
  const t1 = tOf(tip)
  const segs = Math.min(16, Math.max(2, Math.ceil((t1 - t0) / 0.3)))
  const dt = (t1 - t0) / segs
  const flank: { p: P2; d: P2 }[] = []
  for (let i = 0; i <= segs; i++) {
    const t = t0 + dt * i
    const r = rb * Math.sqrt(1 + t * t)
    const psi = psiB - (t - Math.atan(t))
    const drdt = (rb * t) / Math.sqrt(1 + t * t)
    const dpsi = -(t * t) / (1 + t * t)
    flank.push({ p: polar(r, psi), d: [drdt * Math.cos(psi) - r * dpsi * Math.sin(psi), drdt * Math.sin(psi) + r * dpsi * Math.cos(psi)] })
  }
  const flip = (p: P2): P2 => [p[0], -p[1]]
  const psiTip = psiAt(tip)
  const radial = rf < rb - 1e-9

  const first = polar(rf, -psiRoot)
  let pen = R.draw(first)
  for (let k = 0; k < z; k++) {
    const a = k * step
    const R_ = (p: P2) => rot2(p, a)
    if (radial) pen = pen.lineTo(R_(flip(flank[0].p)))
    for (let i = 0; i < segs; i++) {
      const p0 = flip(flank[i].p)
      const p1 = flip(flank[i + 1].p)
      const d0 = flip(flank[i].d)
      const d1 = flip(flank[i + 1].d)
      pen = pen.cubicBezierCurveTo(R_(p1), R_([p0[0] + (d0[0] * dt) / 3, p0[1] + (d0[1] * dt) / 3]), R_([p1[0] - (d1[0] * dt) / 3, p1[1] - (d1[1] * dt) / 3]))
    }
    pen = pen.threePointsArcTo(R_(polar(tip, psiTip)), R_([tip, 0]))
    for (let i = segs; i > 0; i--) {
      const p0 = flank[i].p
      const p1 = flank[i - 1].p
      const d0 = flank[i].d
      const d1 = flank[i - 1].d
      pen = pen.cubicBezierCurveTo(R_(p1), R_([p0[0] - (d0[0] * dt) / 3, p0[1] - (d0[1] * dt) / 3]), R_([p1[0] + (d1[0] * dt) / 3, p1[1] + (d1[1] * dt) / 3]))
    }
    if (radial) pen = pen.lineTo(R_(polar(rf, psiRoot)))
    if (k < z - 1) pen = pen.threePointsArcTo(rot2(polar(rf, -psiRoot), a + step), polar(rf, a + step / 2))
  }
  return pen.threePointsArcTo(first, polar(rf, -step / 2)).close()
}

export interface GearShapeOptions {
  bore?: number
  hub?: { d: number; length: number }
  shaft?: { d: number; length: number }
  holes?: { count: number; d: number; at?: number }
  rim?: number
}

/**
 * Twist extrusion along +Z from `from` by length, turning rate rad/mm,
 * counter-clockwise seen from +Z (a right-hand helix). replicad's twist is
 * a sweep with a helical auxiliary spine; tests pin its direction.
 */
function twisted(d: R.Drawing, from: number, length: number, rate: number): Shape3D {
  return d.sketchOnPlane('XY', from).extrude(length, { twistAngle: rate * length * R2D }) as Shape3D
}

/**
 * The gear in its own frame: axis +Z, centered on z = 0 (bevels: back face
 * on z = 0 with the apex on +Z), tooth 0 on +X. Racks lie along X, the
 * pitch line on y = 0 and the teeth toward −y. placeGear moves it.
 */
export function gearLocalShape(g: GearState, o: GearShapeOptions, what: string): Shape3D {
  if (g.kind === 'rack') return rackShape(g, o, what)
  const { z, rp, rb, ra, rf, alphaT, backlash: b } = g
  const mn = g.mn
  const beta = Math.abs(g.helix) * D2R
  const w = g.kind === 'worm' ? g.length : g.width
  const shiftArc = 2 * g.shift * mn * Math.tan(g.alpha * D2R)

  let drawing: R.Drawing
  if (g.kind === 'internal') {
    const space = ((Math.PI * mn) / 2 + b / 2) / Math.cos(beta)
    const cutter = toothOutline(z, rp, rb, rp + 1.25 * mn, rp - mn, alphaT, space / (2 * rp), what)
    const rimD = o.rim ?? 2 * (rp + 1.25 * mn) + Math.max(6 * mn, 4)
    if (rimD / 2 <= rp + 1.25 * mn + 0.5) throw new Error(`${what}: rim Ø${rimD} must be larger than the tooth roots (Ø${(2 * (rp + 1.25 * mn)).toFixed(2)}) plus a wall`)
    drawing = R.drawCircle(rimD / 2).cut(cutter)
  } else {
    const half = g.kind === 'worm' ? Math.PI / (2 * z) - (b * Math.PI) / (2 * g.lead!) : ((Math.PI * mn) / 2 + shiftArc - b / 2) / Math.cos(beta) / (2 * rp)
    drawing = toothOutline(z, rp, rb, ra, rf, alphaT, half, what)
  }

  const bore = o.bore ?? 0
  if (o.holes && o.holes.count > 0) {
    if (g.kind === 'internal' || g.kind === 'worm') throw new Error(`${what}: holes are for spur, helical, herringbone and bevel gears`)
    const { count, d } = o.holes
    const at = o.holes.at ?? (Math.max(bore / 2, o.hub?.d ? o.hub.d / 2 : 0) + rf) / 2
    if (at + d / 2 > rf - Math.max(mn, 1) || at - d / 2 < Math.max(bore / 2, o.hub ? o.hub.d / 2 : 0) + 0.8)
      throw new Error(`${what}: holes Ø${d} at r=${at.toFixed(2)} must sit between the bore/hub and the tooth roots (r < ${(rf - Math.max(mn, 1)).toFixed(2)})`)
    for (let i = 0; i < count; i++) {
      const a = ((i + 0.5) / count) * 2 * Math.PI
      drawing = drawing.cut(R.drawCircle(d / 2).translate(at * Math.cos(a), at * Math.sin(a)))
    }
  }
  if (bore && g.kind !== 'internal') {
    if (bore / 2 >= rf - 0.5) throw new Error(`${what}: bore Ø${bore} leaves no material under the teeth (root Ø${(2 * rf).toFixed(2)})`)
    drawing = drawing.cut(R.drawCircle(bore / 2))
  }

  let solid: Shape3D
  let z0 = -w / 2
  let z1 = w / 2
  if (g.kind === 'bevel') {
    const cone = g.cone! * D2R
    const L = w * Math.cos(cone)
    const f = 1 - (w * Math.sin(cone)) / rp
    if (f <= 0.2) throw new Error(`${what}: width ${w} is too long for this bevel (the teeth run into the apex); keep it under ${((0.8 * rp) / Math.sin(cone)).toFixed(1)}`)
    solid = drawing.sketchOnPlane('XY', 0).extrude(L, { extrusionProfile: { profile: 'linear', endFactor: f } }) as Shape3D
    z0 = 0
    z1 = L
  } else if (beta < 1e-9 && g.kind !== 'worm') {
    solid = drawing.sketchOnPlane('XY', -w / 2).extrude(w) as Shape3D
  } else {
    const rate = g.kind === 'worm' ? (2 * Math.PI) / g.lead! : Math.tan(beta) / rp
    if (g.kind === 'herringbone') {
      const halfShape = twisted(drawing, 0, w / 2, rate)
      solid = (halfShape.clone().mirror('XY', [0, 0, 0]) as Shape3D).fuse(halfShape) as Shape3D
    } else {
      // Start rotated back by half the twist so the mid-plane has tooth 0 on +X.
      solid = twisted(drawing.rotate((-rate * w * R2D) / 2, [0, 0]), -w / 2, w, rate)
    }
    if (g.helix < 0) solid = solid.mirror('XZ', [0, 0, 0]) as Shape3D
  }

  if (o.hub) {
    const { d, length } = o.hub
    if (d / 2 >= rf - 0.3) throw new Error(`${what}: hub Ø${d} is larger than the tooth roots (Ø${(2 * rf).toFixed(2)})`)
    const hub = g.kind === 'bevel' ? R.makeCylinder(d / 2, length + 0.01, [0, 0, -length], [0, 0, 1]) : R.makeCylinder(d / 2, length + 0.01, [0, 0, z1 - 0.01], [0, 0, 1])
    solid = solid.fuse(hub) as Shape3D
  }
  if (o.shaft) {
    const { d, length } = o.shaft
    if (d / 2 >= rf) throw new Error(`${what}: shaft Ø${d} is larger than the tooth roots`)
    const mid = (z0 + z1) / 2
    solid = solid.fuse(R.makeCylinder(d / 2, length, [0, 0, mid - length / 2], [0, 0, 1])) as Shape3D
  }
  if (bore && (o.hub || o.shaft) && g.kind !== 'internal') {
    if (o.shaft && o.shaft.d >= bore) throw new Error(`${what}: a shaft Ø${o.shaft.d} fills the bore Ø${bore}; drop one of them`)
    const reach = (o.hub?.length ?? 0) + (o.shaft?.length ?? 0) + w + 4
    solid = solid.cut(R.makeCylinder(bore / 2, reach * 2, [0, 0, -reach], [0, 0, 1])) as Shape3D
  }
  return solid
}

function rackShape(g: GearState, o: GearShapeOptions, what: string): Shape3D {
  const { m, backlash: b } = g
  const ta = Math.tan(g.alpha * D2R)
  const p = Math.PI * m
  const s = (Math.PI * m) / 2 - b / 2
  const ha = m
  const hf = 1.25 * m
  const back = o.rim ?? 2.5 * m
  const L = g.length
  if (L < 2 * p) throw new Error(`${what}: length ${L} is shorter than two tooth pitches (${(2 * p).toFixed(2)})`)
  if (s / 2 - ha * ta <= 0.05 * m) throw new Error(`${what}: the rack teeth are pointed; lower pressure_angle`)
  // Tooth k centered on x = k·p, tips toward −y; the outline closes behind the roots.
  const pts: P2[] = [[-L / 2, hf + back], [-L / 2, hf]]
  for (let k = Math.ceil((-L / 2 + s / 2 + hf * ta + 1e-6) / p); k * p + s / 2 + hf * ta < L / 2 - 1e-6; k++) {
    const c = k * p
    pts.push([c - s / 2 - hf * ta, hf], [c - s / 2 + ha * ta, -ha], [c + s / 2 - ha * ta, -ha], [c + s / 2 + hf * ta, hf])
  }
  pts.push([L / 2, hf], [L / 2, hf + back])
  // Drop repeated points (a tooth root landing on the previous one).
  const clean = pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 1e-6)
  let pen = R.draw(clean[0])
  for (const q of clean.slice(1)) pen = pen.lineTo(q)
  return pen.close().sketchOnPlane('XY', -g.width / 2).extrude(g.width) as Shape3D
}

/** Spins (or slides) a local gear solid, then turns it onto its frame and moves it to its center. */
export function placeGear(s: Shape3D, g: GearState): Shape3D {
  if (g.kind === 'rack') {
    if (g.travel) s = s.translate(g.travel, 0, 0)
  } else if (g.rotation) s = s.rotate(g.rotation, [0, 0, 0], [0, 0, 1])
  const { k, angle } = axisAngleOf(g.frame)
  if (angle) s = s.rotate(angle * R2D, [0, 0, 0], k)
  const c = g.center
  if (c[0] || c[1] || c[2]) s = s.translate(c[0], c[1], c[2])
  return s
}

export function gearOptions(f: GearFeature, params: Params): GearShapeOptions {
  const N = (e: Parameters<typeof num>[0], field: string, fb?: number) => num(e, params, `${f.name}.${field}`, fb)
  const o: GearShapeOptions = {}
  if (f.bore !== undefined) o.bore = N(f.bore, 'bore')
  if (f.hub) o.hub = { d: N(f.hub.d, 'hub.d'), length: N(f.hub.length, 'hub.length') }
  if (f.shaft) o.shaft = { d: N(f.shaft.d, 'shaft.d'), length: N(f.shaft.length, 'shaft.length') }
  if (f.holes) o.holes = { count: Math.round(N(f.holes.count, 'holes.count')), d: N(f.holes.d, 'holes.d'), at: f.holes.at === undefined ? undefined : N(f.holes.at, 'holes.at') }
  if (f.rim !== undefined) o.rim = N(f.rim, 'rim')
  return o
}

/** The part of a state that decides the local shape (not where it sits or how far it turned). */
export function localKey(g: GearState, o: GearShapeOptions): string {
  return JSON.stringify([g.kind, g.z, g.m, g.mn, g.alpha, g.helix, g.shift, g.backlash, g.width, g.length, g.rp, g.cone, g.lead, o])
}

const r3 = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d

/** Gear facts for the model. */
export function describeGear(g: GearState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: g.name,
    kind: g.kind,
    teeth: g.z,
    module: g.m,
    pitch_d: r3(2 * g.rp),
    tip_d: g.kind === 'internal' ? r3(2 * (g.rp - g.mn)) : r3(2 * g.ra),
    root_d: g.kind === 'internal' ? r3(2 * (g.rp + 1.25 * g.mn)) : r3(2 * g.rf),
    center: g.center.map((v) => r3(v)),
    axis: g.frame.a.map((v) => r3(v, 4)),
  }
  if (g.kind === 'rack') out.travel = r3(g.travel)
  else out.rotation = r3(g.rotation, 2)
  if (g.helix) out[g.kind === 'worm' ? 'lead_angle' : 'helix'] = r3(g.helix)
  if (g.cone) out.cone_angle = r3(g.cone)
  if (g.lead) out.lead = r3(g.lead)
  if (g.partner) out[g.relation === 'mesh' ? 'meshes_with' : 'on_shaft_of'] = g.partner
  out[g.kind === 'rack' ? 'mm_per_input_turn' : 'turns_per_input_turn'] = r3(g.ratio, 5)
  if (g.warnings.length) out.warnings = g.warnings
  return out
}
