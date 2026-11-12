// Motion: what moves when the driven parameter changes. The plan maps each
// moving body to a rigid motion (rotate about an axis, slide along one) as
// a function of the parameter, so playback just poses meshes; nothing is
// rebuilt. Most motions are linear (a rate per unit of the parameter);
// cams, geneva wheels and position expressions follow a curve; a planet
// gear also orbits. Gears, geneva pairs, cams and belts get their motion
// from their features; other bodies from motion joints. Physics bodies are
// listed for the simulator.

import { type Doc, type Joint, bodies, effectiveParameters } from './doc'
import { evaluate, num, resolveParameters } from './expr'
import { type GearState, GearError, gearStates } from './gears'
import { beltStates, camStates, genevaAngle, genevaStates } from './mechanisms'

export type V3 = [number, number, number]

/**
 * A nonlinear motion: the amount (degrees or mm) is f(at + rate·d) − f(at),
 * d = value − base. table: samples over one period, linear between them;
 * geneva: the wheel angle for a drive angle; expr: an expression of the
 * drive parameter (rate 1, at = base) with the other parameters fixed.
 */
export type Curve =
  | { kind: 'table'; period: number; values: number[]; rate: number; at: number }
  | { kind: 'geneva'; slots: number; k: number; rate: number; at: number }
  | { kind: 'expr'; expr: string; param: string; vars: Record<string, number>; rate: number; at: number }

export interface BodyMotion {
  body: string
  kind: 'rotate' | 'slide'
  axis: V3
  origin: V3
  /** Degrees or mm per unit of the parameter (ignored when curve is set). */
  rate: number
  curve?: Curve
  /** Also turns about this axis (a planet around its sun), degrees per unit, applied after the own motion. */
  orbit?: { axis: V3; origin: V3; rate: number }
  /** Where it came from. */
  from: 'gear' | 'joint' | 'cam' | 'geneva' | 'belt'
}

export interface MotionPlan {
  param?: string
  speed: number
  mode: 'forever' | 'loop' | 'bounce'
  range?: [number, number]
  /** Value of the parameter in the document (the pose the meshes were built at). */
  base: number
  moves: BodyMotion[]
  physics: { name: string; density: number; friction: number; restitution: number; velocity: V3; spin: V3 }[]
  gravity: number
  floor: boolean
  problems: string[]
}

const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

function curveValue(c: Curve, x: number): number {
  switch (c.kind) {
    case 'table': {
      const n = c.values.length
      const p = (((x % c.period) + c.period) % c.period) / (c.period / n)
      const i = Math.floor(p)
      const f = p - i
      return c.values[i % n] * (1 - f) + c.values[(i + 1) % n] * f
    }
    case 'geneva':
      return genevaAngle(c.slots, c.k, x)
    case 'expr':
      return evaluate(c.expr, (n) => (n === c.param ? x : c.vars[n]))
  }
}

/** How far a body has turned (degrees) or slid (mm) at parameter offset d. */
export function amountOf(mv: BodyMotion, d: number): number {
  const c = mv.curve
  if (!c) return mv.rate * d
  try {
    return curveValue(c, c.at + c.rate * d) - curveValue(c, c.at)
  } catch {
    return 0
  }
}

/** The parameter that drives the model: the motion drive, or the first gear's (or mechanism's) rotation parameter. */
function driveParam(doc: Doc): string | undefined {
  if (doc.motion?.drive?.param) return doc.motion.drive.param
  const isName = (e: unknown) => typeof e === 'string' && /^[A-Za-z_]\w*$/.test(e.trim())
  for (const f of doc.features) {
    if (f.type === 'gear' && !f.mesh && !f.coaxial && isName(f.rotation)) return (f.rotation as string).trim()
    if (f.type === 'cam' && isName(f.rotation)) return (f.rotation as string).trim()
    if (f.type === 'geneva' && f.part === 'drive' && isName(f.angle)) return (f.angle as string).trim()
  }
  return undefined
}

export function motionPlan(doc: Doc, params: Map<string, number>): MotionPlan {
  const problems: string[] = []
  const m = doc.motion ?? {}
  const param = driveParam(doc)
  const plan: MotionPlan = {
    param,
    speed: m.drive?.speed ?? 30,
    mode: m.drive?.mode ?? 'forever',
    range: m.drive?.range,
    base: param ? (params.get(param) ?? 0) : 0,
    moves: [],
    physics: [],
    gravity: m.physics?.gravity ?? 9810,
    floor: m.physics?.floor ?? true,
    problems,
  }
  const visible = new Set(bodies(doc).map((f) => f.name))
  let bumped: Map<string, number> | undefined
  if (param) {
    try {
      bumped = resolveParameters(effectiveParameters(doc).map((p) => (p.name === param ? { ...p, expr: plan.base + 1 } : p)))
    } catch (e) {
      problems.push(`cannot vary ${param}: ${(e as Error).message}`)
    }
  }
  const byBody = new Map<string, BodyMotion>()

  // Gears: rates by finite difference on the driven parameter. A gear turns
  // in place when its center stays put; a planet whose center circles the
  // axis of a gear it hangs from also orbits.
  if (param && bumped && doc.features.some((f) => f.type === 'gear')) {
    const g0 = gearStates(doc, params)
    const g1 = gearStates(doc, bumped)
    for (const [name, a] of g0) {
      const b = g1.get(name)
      if (a instanceof GearError || !b || b instanceof GearError || !visible.has(name)) continue
      const moved = Math.hypot(...sub(a.center, b.center)) > 1e-9
      if (a.kind === 'rack') {
        const rate = b.travel - a.travel
        if (moved) problems.push(`rack "${name}" changes place with ${param}; it is shown still`)
        else if (Math.abs(rate) > 1e-12) byBody.set(name, { body: name, kind: 'slide', axis: a.frame.u, origin: a.center, rate, from: 'gear' })
        continue
      }
      let orbit: BodyMotion['orbit']
      if (moved) {
        orbit = orbitOf(a, b, g0, g1)
        if (!orbit) {
          problems.push(`gear "${name}" changes place with ${param} in a way that is not a turn about a fixed gear axis; it is shown still`)
          continue
        }
      }
      // Turning the planet with the carrier already adds the orbit angle to its own spin.
      const spin = b.rotation - a.rotation - (orbit ? orbit.rate * dot(orbit.axis, a.frame.a) : 0)
      if (Math.abs(spin) < 1e-12 && !orbit) continue
      byBody.set(name, { body: name, kind: 'rotate', axis: a.frame.a, origin: a.center, rate: spin, from: 'gear', ...(orbit ? { orbit } : {}) })
    }
  }

  // Geneva pairs and cams turn from their angle expression.
  const genevas = genevaStates(doc, params)
  const genevas1 = bumped ? genevaStates(doc, bumped) : undefined
  for (const [name, g] of genevas) {
    if (g instanceof Error) continue
    const b = genevas1?.get(name)
    const rate = b && !(b instanceof Error) ? b.angle - g.angle : 0
    if (visible.has(g.drive) && Math.abs(rate) > 1e-12) byBody.set(g.drive, { body: g.drive, kind: 'rotate', axis: g.axis, origin: g.center, rate, from: 'geneva' })
  }
  const cams = camStates(doc, params)
  const cams1 = bumped ? camStates(doc, bumped) : undefined
  for (const [name, c] of cams) {
    if (c instanceof Error) continue
    const b = cams1?.get(name)
    const rate = b && !(b instanceof Error) ? b.rotation - c.rotation : 0
    if (visible.has(name) && Math.abs(rate) > 1e-12) byBody.set(name, { body: name, kind: 'rotate', axis: c.axis, origin: c.center, rate, from: 'cam' })
  }

  // Joints.
  const pending: Joint[] = []
  for (const j of m.joints ?? []) {
    if (!visible.has(j.body)) {
      problems.push(`joint on "${j.body}": not a visible body`)
      continue
    }
    if (j.kind === 'follow' || j.kind === 'cam') {
      pending.push(j)
      continue
    }
    if (j.param && j.param !== param) {
      problems.push(`joint on "${j.body}" is driven by ${j.param}, but Play drives ${param ?? '(nothing)'}; set motion drive to ${j.param}`)
      continue
    }
    try {
      const axis = unit(j.axis!.map((v, i) => num(v, params, `joint ${j.body}.axis[${i}]`)) as V3)
      const origin = (j.origin ?? [0, 0, 0]).map((v, i) => num(v, params, `joint ${j.body}.origin[${i}]`)) as V3
      const rate = num(j.rate ?? 1, params, `joint ${j.body}.rate`)
      const mv: BodyMotion = { body: j.body, kind: j.kind === 'slide' ? 'slide' : 'rotate', axis, origin, rate, from: 'joint' }
      if (j.position) {
        if (!param) throw new Error(`joint on "${j.body}": position needs a driven parameter (set motion drive)`)
        const vars = Object.fromEntries([...params].filter(([k]) => k !== param))
        evaluate(j.position, (n) => (n === param ? plan.base : vars[n]))
        mv.curve = { kind: 'expr', expr: j.position, param, vars, rate: 1, at: plan.base }
      }
      if (byBody.has(j.body)) problems.push(`"${j.body}" already moves (${byBody.get(j.body)!.from}); its joint replaces that motion`)
      byBody.set(j.body, mv)
    } catch (e) {
      problems.push((e as Error).message)
    }
  }

  const resolvePending = (final: boolean) => {
    for (const j of [...pending]) {
      if (j.kind === 'follow') {
        const src = byBody.get(j.follow!)
        if (!src) {
          if (final) problems.push(`joint on "${j.body}" follows "${j.follow}", which does not move`)
          continue
        }
        byBody.set(j.body, { ...src, body: j.body, from: 'joint' })
        pending.splice(pending.indexOf(j), 1)
        continue
      }
      const c = cams.get(j.cam!)
      pending.splice(pending.indexOf(j), 1)
      if (!c || c instanceof Error) {
        problems.push(`joint on "${j.body}": no cam "${j.cam}"${c ? `: ${c.message}` : ''}`)
        continue
      }
      const cm = byBody.get(j.cam!)
      if (!cm || cm.kind !== 'rotate' || cm.curve) {
        problems.push(`joint on "${j.body}" follows cam "${j.cam}", which does not turn; make its rotation an expression of the drive parameter`)
        continue
      }
      // The follower sits at a fixed angle; the cam angle under it falls as the cam turns.
      const sign = dot(cm.axis, c.axis) >= 0 ? 1 : -1
      byBody.set(j.body, {
        body: j.body,
        kind: 'slide',
        axis: c.followerDir,
        origin: c.center,
        rate: 0,
        curve: { kind: 'table', period: 360, values: c.lift, rate: -cm.rate * sign, at: c.followerAt - c.rotation },
        from: 'cam',
      })
    }
  }

  // Bodies driven by other moving bodies: geneva wheels, belts, cam
  // followers, follow joints. Repeat so chains resolve in any order.
  const belts = beltStates(doc, params)
  for (let round = 0; round < 6; round++) {
    resolvePending(false)
    for (const [, g] of genevas) {
      if (g instanceof Error || byBody.has(g.wheel) || !visible.has(g.wheel)) continue
      const d = byBody.get(g.drive)
      if (!d || d.kind !== 'rotate' || d.curve || d.orbit) continue
      const sign = dot(d.axis, g.axis) >= 0 ? 1 : -1
      byBody.set(g.wheel, {
        body: g.wheel,
        kind: 'rotate',
        axis: g.axis,
        origin: g.wheelCenter,
        rate: 0,
        curve: { kind: 'geneva', slots: g.slots, k: g.k, rate: d.rate * sign, at: g.angle },
        from: 'geneva',
      })
    }
    for (const [name, b] of belts) {
      if (b instanceof Error) continue
      const driver = b.pulleys.find((p) => p.body && byBody.has(p.body) && byBody.get(p.body)!.kind === 'rotate' && !byBody.get(p.body)!.curve)
      if (!driver) continue
      const d = byBody.get(driver.body!)!
      const sign = dot(d.axis, b.normal) >= 0 ? 1 : -1
      for (const p of b.pulleys) {
        if (!p.body || byBody.has(p.body) || !visible.has(p.body)) continue
        // A back idler turns against the pulleys the belt runs around.
        const turn = (driver.back ? -1 : 1) * (p.back ? -1 : 1)
        byBody.set(p.body, { body: p.body, kind: 'rotate', axis: b.normal, origin: p.center, rate: (d.rate * sign * turn * driver.r) / p.r, from: 'belt' })
      }
      void name
    }
  }
  resolvePending(true)
  plan.moves = [...byBody.values()]

  for (const b of m.physics?.bodies ?? []) {
    if (!visible.has(b.name)) {
      problems.push(`physics body "${b.name}": not a visible body`)
      continue
    }
    if (byBody.has(b.name)) {
      problems.push(`"${b.name}" is both driven and loose; drop it from physics or from the joints`)
      continue
    }
    plan.physics.push({
      name: b.name,
      density: b.density ?? 1.25,
      friction: b.friction ?? 0.5,
      restitution: b.restitution ?? 0.2,
      velocity: b.velocity ?? [0, 0, 0],
      spin: b.spin ?? [0, 0, 0],
    })
  }
  return plan
}

/**
 * A gear whose center moves: find a gear up its chain whose center stays
 * put and whose axis is parallel, and check the center circles that axis.
 * Returns the orbit rate in degrees per unit of the parameter.
 */
function orbitOf(a: GearState, b: GearState, g0: Map<string, GearState | GearError>, g1: Map<string, GearState | GearError>): BodyMotion['orbit'] {
  let p = a.partner
  for (let i = 0; i < 20 && p; i++) {
    const s0 = g0.get(p)
    const s1 = g1.get(p)
    if (!s0 || !s1 || s0 instanceof GearError || s1 instanceof GearError) return undefined
    if (Math.hypot(...sub(s0.center, s1.center)) < 1e-9) {
      const ax = s0.frame.a
      if (Math.abs(Math.abs(dot(ax, a.frame.a)) - 1) > 1e-9) return undefined
      const ra = sub(a.center, s0.center)
      const rb = sub(b.center, s0.center)
      const ha = dot(ra, ax)
      const hb = dot(rb, ax)
      const pa = sub(ra, [ax[0] * ha, ax[1] * ha, ax[2] * ha])
      const pb = sub(rb, [ax[0] * hb, ax[1] * hb, ax[2] * hb])
      if (Math.abs(ha - hb) > 1e-7 || Math.abs(Math.hypot(...pa) - Math.hypot(...pb)) > 1e-7) return undefined
      const c: V3 = [pa[1] * pb[2] - pa[2] * pb[1], pa[2] * pb[0] - pa[0] * pb[2], pa[0] * pb[1] - pa[1] * pb[0]]
      const rate = (Math.atan2(dot(c, ax), dot(pa, pb)) * 180) / Math.PI
      return { axis: ax, origin: s0.center, rate }
    }
    p = s0.partner
  }
  return undefined
}

/** Rotation quaternion (x, y, z, w) about a unit axis by degrees. */
export function quatOf(axis: V3, deg: number): [number, number, number, number] {
  const h = (deg * Math.PI) / 360
  const s = Math.sin(h)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)]
}
