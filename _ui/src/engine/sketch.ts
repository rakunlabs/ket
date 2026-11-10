// Constrained 2D sketches, solved by FreeCAD's planegcs (WASM).
//
// The document stores sketches in our own vocabulary (points by name,
// constraints like "horizontal" or "distance"); this module maps them to
// planegcs primitives, solves, and reports the result in terms a model can
// act on: degrees of freedom left, which constraints conflict, and the
// closed loops (profiles) that features can extrude or revolve.

import type { GcsWrapper, SketchPrimitive } from '@salusoft89/planegcs'

import type { Sketch, SketchConstraint, SketchEntity } from './doc'
import { num } from './expr'

export type P2 = [number, number]

export interface SolvedSketch {
  name: string
  ok: boolean
  /** Degrees of freedom left; 0 = fully constrained. */
  dof: number
  status: 'solved' | 'conflict' | 'redundant' | 'failed' | 'empty'
  message?: string
  /** Constraint indices (into sketch.constraints) that conflict. */
  conflicting?: number[]
  redundant?: number[]
  points: Record<string, P2>
  entities: SolvedEntity[]
  /** Closed outlines made of non-construction entities, outermost first. */
  loops: Loop[]
}

export type SolvedEntity =
  | { id: string; kind: 'line'; a: P2; b: P2; construction?: boolean }
  | { id: string; kind: 'circle'; c: P2; r: number; construction?: boolean }
  | { id: string; kind: 'arc'; c: P2; r: number; start: P2; end: P2; construction?: boolean }

export interface Loop {
  /** Entity ids in order around the loop. */
  entities: string[]
  segments: Segment[]
  area: number
}

export type Segment =
  | { kind: 'line'; from: P2; to: P2 }
  | { kind: 'arc'; from: P2; to: P2; mid: P2 }
  | { kind: 'circle'; c: P2; r: number }

let wrapper: GcsWrapper | undefined

/** Sets the planegcs instance (the browser worker and Node tests differ in loading). */
export function setGcs(w: GcsWrapper) {
  wrapper = w
}

const CONSTRAINT_KINDS = [
  'coincident',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'equal',
  'tangent',
  'point_on',
  'midpoint',
  'distance',
  'distance_x',
  'distance_y',
  'length',
  'radius',
  'angle',
  'fix',
  'symmetric',
] as const

export { CONSTRAINT_KINDS }

/** Solves a sketch. Parameters feed every Expr in it. */
export function solveSketch(s: Sketch, params: Map<string, number>): SolvedSketch {
  const what = `sketch ${s.name}`
  const pts = new Map<string, P2>()
  for (const p of s.points) {
    if (pts.has(p.id)) throw new Error(`${what}: duplicate point "${p.id}"`)
    pts.set(p.id, [num(p.x, params, `${what}.points.${p.id}.x`), num(p.y, params, `${what}.points.${p.id}.y`)])
  }
  const ents = new Map<string, SketchEntity>()
  for (const e of s.entities) {
    if (ents.has(e.id) || pts.has(e.id)) throw new Error(`${what}: duplicate id "${e.id}"`)
    ents.set(e.id, e)
  }

  const needPoint = (id: string, ctx: string) => {
    if (!pts.has(id)) throw new Error(`${what}: ${ctx} refers to point "${id}", which does not exist; points are: ${[...pts.keys()].join(', ') || '(none)'}`)
  }
  const needEntity = (id: string, ctx: string, kinds?: SketchEntity['kind'][]) => {
    const e = ents.get(id)
    if (!e) throw new Error(`${what}: ${ctx} refers to "${id}", which is not a line, circle or arc; entities are: ${[...ents.keys()].join(', ') || '(none)'}`)
    if (kinds && !kinds.includes(e.kind)) throw new Error(`${what}: ${ctx} needs a ${kinds.join(' or ')}, but "${id}" is a ${e.kind}`)
    return e
  }

  for (const e of s.entities) {
    if (e.kind === 'line') {
      needPoint(e.a, `line ${e.id}`)
      needPoint(e.b, `line ${e.id}`)
      if (e.a === e.b) throw new Error(`${what}: line ${e.id} starts and ends at the same point`)
    } else if (e.kind === 'circle') needPoint(e.center, `circle ${e.id}`)
    else {
      needPoint(e.center, `arc ${e.id}`)
      needPoint(e.start, `arc ${e.id}`)
      needPoint(e.end, `arc ${e.id}`)
    }
  }

  if (!wrapper) throw new Error('the sketch solver is not loaded')
  const w = wrapper
  w.clear_data()

  // planegcs requires referenced ids to come first; we use prefixed ids so
  // points, entities and constraints cannot clash.
  const prims: SketchPrimitive[] = []
  for (const p of s.points) {
    const [x, y] = pts.get(p.id)!
    prims.push({ id: `p:${p.id}`, type: 'point', x, y, fixed: !!p.fixed })
  }
  for (const e of s.entities) {
    if (e.kind === 'line') prims.push({ id: `e:${e.id}`, type: 'line', p1_id: `p:${e.a}`, p2_id: `p:${e.b}` })
    else if (e.kind === 'circle') {
      prims.push({ id: `e:${e.id}`, type: 'circle', c_id: `p:${e.center}`, radius: num(e.r, params, `${what}.${e.id}.r`) })
    } else {
      const c = pts.get(e.center)!
      const st = pts.get(e.start)!
      const en = pts.get(e.end)!
      const a0 = Math.atan2(st[1] - c[1], st[0] - c[0])
      let a1 = Math.atan2(en[1] - c[1], en[0] - c[0])
      if (a1 <= a0) a1 += 2 * Math.PI
      prims.push({
        id: `e:${e.id}`,
        type: 'arc',
        c_id: `p:${e.center}`,
        start_id: `p:${e.start}`,
        end_id: `p:${e.end}`,
        radius: Math.hypot(st[0] - c[0], st[1] - c[1]) || 1,
        start_angle: a0,
        end_angle: a1,
      } as SketchPrimitive)
      prims.push({ id: `r:${e.id}`, type: 'arc_rules', a_id: `e:${e.id}` } as SketchPrimitive)
    }
  }

  const isPoint = (id: string) => pts.has(id)

  s.constraints.forEach((c, i) => {
    const id = `c:${i}`
    const at = `constraint ${i + 1} (${c.kind})`
    const v = (e: unknown, field = 'value') => num(e as never, params, `${what}.${at}.${field}`)
    const add = (p: Record<string, unknown>) => prims.push({ id, ...p } as unknown as SketchPrimitive)
    switch (c.kind) {
      case 'coincident':
        needPoint(c.a, at)
        needPoint(c.b, at)
        add({ type: 'p2p_coincident', p1_id: `p:${c.a}`, p2_id: `p:${c.b}` })
        break
      case 'horizontal':
      case 'vertical':
        if (isPoint(c.line)) throw new Error(`${what}: ${at} takes a line; to align two points use distance_${c.kind === 'horizontal' ? 'y' : 'x'} with value 0`)
        needEntity(c.line, at, ['line'])
        add({ type: c.kind === 'horizontal' ? 'horizontal_l' : 'vertical_l', l_id: `e:${c.line}` })
        break
      case 'parallel':
      case 'perpendicular':
        needEntity(c.a, at, ['line'])
        needEntity(c.b, at, ['line'])
        add(c.kind === 'parallel' ? { type: 'parallel', l1_id: `e:${c.a}`, l2_id: `e:${c.b}` } : { type: 'perpendicular_ll', l1_id: `e:${c.a}`, l2_id: `e:${c.b}` })
        break
      case 'equal': {
        const a = needEntity(c.a, at)
        const b = needEntity(c.b, at)
        if (a.kind === 'line' && b.kind === 'line') add({ type: 'equal_length', l1_id: `e:${c.a}`, l2_id: `e:${c.b}` })
        else if (a.kind === 'circle' && b.kind === 'circle') add({ type: 'equal_radius_cc', c1_id: `e:${c.a}`, c2_id: `e:${c.b}` })
        else if (a.kind === 'arc' && b.kind === 'arc') add({ type: 'equal_radius_aa', a1_id: `e:${c.a}`, a2_id: `e:${c.b}` })
        else if (a.kind === 'circle' && b.kind === 'arc') add({ type: 'equal_radius_ca', c1_id: `e:${c.a}`, a2_id: `e:${c.b}` })
        else if (a.kind === 'arc' && b.kind === 'circle') add({ type: 'equal_radius_ca', c1_id: `e:${c.b}`, a2_id: `e:${c.a}` })
        else throw new Error(`${what}: ${at}: equal needs two lines (length) or two circles/arcs (radius)`)
        break
      }
      case 'tangent': {
        const a = needEntity(c.a, at)
        const b = needEntity(c.b, at)
        const [l, o] = a.kind === 'line' ? [a, b] : b.kind === 'line' ? [b, a] : [undefined, undefined]
        if (l && o) {
          if (o.kind === 'line') throw new Error(`${what}: ${at}: two lines cannot be tangent; use parallel or coincident`)
          add(o.kind === 'circle' ? { type: 'tangent_lc', l_id: `e:${l.id}`, c_id: `e:${o.id}` } : { type: 'tangent_la', l_id: `e:${l.id}`, a_id: `e:${o.id}` })
        } else if (a.kind === 'circle' && b.kind === 'circle') {
          add({ type: 'tangent_cc', c1_id: `e:${c.a}`, c2_id: `e:${c.b}` })
        } else if (a.kind === 'arc' && b.kind === 'arc') {
          add({ type: 'tangent_aa', a1_id: `e:${c.a}`, a2_id: `e:${c.b}` })
        } else {
          const [circ, arc] = a.kind === 'circle' ? [a, b] : [b, a]
          add({ type: 'tangent_ca', c_id: `e:${circ.id}`, a_id: `e:${arc.id}` })
        }
        break
      }
      case 'point_on': {
        needPoint(c.point, at)
        const e = needEntity(c.on, at)
        const p = `p:${c.point}`
        if (e.kind === 'line') add({ type: 'point_on_line_pl', p_id: p, l_id: `e:${c.on}` })
        else if (e.kind === 'circle') add({ type: 'point_on_circle', p_id: p, c_id: `e:${c.on}` })
        else add({ type: 'point_on_arc', p_id: p, a_id: `e:${c.on}` })
        break
      }
      case 'midpoint': {
        needPoint(c.point, at)
        const l = needEntity(c.line, at, ['line']) as Extract<SketchEntity, { kind: 'line' }>
        add({ type: 'p2p_symmetric_ppp', p1_id: `p:${l.a}`, p2_id: `p:${l.b}`, p_id: `p:${c.point}` })
        break
      }
      case 'distance': {
        const value = v(c.value)
        if (value < 0) throw new Error(`${what}: ${at}: distance must be ≥ 0`)
        if (isPoint(c.a) && isPoint(c.b)) add({ type: 'p2p_distance', p1_id: `p:${c.a}`, p2_id: `p:${c.b}`, distance: value })
        else if (isPoint(c.a) || isPoint(c.b)) {
          const [p, l] = isPoint(c.a) ? [c.a, c.b] : [c.b, c.a]
          const e = needEntity(l, at)
          if (e.kind === 'line') add({ type: 'p2l_distance', p_id: `p:${p}`, l_id: `e:${l}`, distance: value })
          else add({ type: 'p2cdistance', p_id: `p:${p}`, c_id: `e:${l}`, distance: value })
        } else throw new Error(`${what}: ${at}: distance is between two points or a point and a line/circle; for a line's length use length`)
        break
      }
      case 'distance_x':
      case 'distance_y': {
        needPoint(c.a, at)
        needPoint(c.b, at)
        const prop = c.kind === 'distance_x' ? 'x' : 'y'
        // b.prop - a.prop = value
        add({ type: 'difference', param1: { o_id: `p:${c.a}`, prop }, param2: { o_id: `p:${c.b}`, prop }, difference: v(c.value) })
        break
      }
      case 'length': {
        const l = needEntity(c.line, at, ['line']) as Extract<SketchEntity, { kind: 'line' }>
        const value = v(c.value)
        if (value <= 0) throw new Error(`${what}: ${at}: length must be > 0`)
        add({ type: 'p2p_distance', p1_id: `p:${l.a}`, p2_id: `p:${l.b}`, distance: value })
        break
      }
      case 'radius': {
        const e = needEntity(c.of, at, ['circle', 'arc'])
        const value = v(c.value)
        if (value <= 0) throw new Error(`${what}: ${at}: radius must be > 0`)
        add(e.kind === 'circle' ? { type: 'circle_radius', c_id: `e:${c.of}`, radius: value } : { type: 'arc_radius', a_id: `e:${c.of}`, radius: value })
        break
      }
      case 'angle': {
        needEntity(c.a, at, ['line'])
        needEntity(c.b, at, ['line'])
        add({ type: 'l2l_angle_ll', l1_id: `e:${c.a}`, l2_id: `e:${c.b}`, angle: (v(c.value) * Math.PI) / 180 })
        break
      }
      case 'fix': {
        needPoint(c.point, at)
        if (c.x === undefined && c.y === undefined) {
          const [x, y] = pts.get(c.point)!
          add({ type: 'coordinate_x', p_id: `p:${c.point}`, x })
          prims.push({ id: `${id}y`, type: 'coordinate_y', p_id: `p:${c.point}`, y } as unknown as SketchPrimitive)
        } else {
          if (c.x !== undefined) add({ type: 'coordinate_x', p_id: `p:${c.point}`, x: v(c.x, 'x') })
          if (c.y !== undefined) {
            prims.push({ id: c.x !== undefined ? `${id}y` : id, type: 'coordinate_y', p_id: `p:${c.point}`, y: v(c.y, 'y') } as unknown as SketchPrimitive)
          }
        }
        break
      }
      case 'symmetric': {
        needPoint(c.a, at)
        needPoint(c.b, at)
        if (isPoint(c.about)) add({ type: 'p2p_symmetric_ppp', p1_id: `p:${c.a}`, p2_id: `p:${c.b}`, p_id: `p:${c.about}` })
        else {
          needEntity(c.about, at, ['line'])
          add({ type: 'p2p_symmetric_ppl', p1_id: `p:${c.a}`, p2_id: `p:${c.b}`, l_id: `e:${c.about}` })
        }
        break
      }
      default:
        throw new Error(`${what}: unknown constraint kind "${(c as { kind: string }).kind}"; use one of ${CONSTRAINT_KINDS.join(', ')}`)
    }
  })

  const result: SolvedSketch = { name: s.name, ok: true, dof: 0, status: 'solved', points: {}, entities: [], loops: [] }
  if (!s.points.length) {
    result.status = 'empty'
    return result
  }

  w.push_primitives_and_params(prims)
  const status = w.solve()
  w.apply_solution()

  const constraintIndex = (gid: string) => {
    const m = /^c:(\d+)/.exec(gid)
    return m ? Number(m[1]) : -1
  }
  const conflicting = [...new Set(w.get_gcs_conflicting_constraints().map(constraintIndex).filter((i) => i >= 0))]
  const redundant = [...new Set(w.get_gcs_redundant_constraints().map(constraintIndex).filter((i) => i >= 0))]
  result.dof = Math.max(0, w.gcs.dof())

  const describeC = (i: number) => `#${i + 1} ${summarizeConstraint(s.constraints[i])}`
  if (conflicting.length) {
    result.ok = false
    result.status = 'conflict'
    result.conflicting = conflicting
    result.message = `constraints conflict: ${conflicting.map(describeC).join('; ')}. Remove or change one of them.`
  } else if (redundant.length) {
    result.status = 'redundant'
    result.redundant = redundant
    result.message = `redundant constraints (already implied by others): ${redundant.map(describeC).join('; ')}. Remove them.`
  } else if (status === 2 || status === 3) {
    result.ok = false
    result.status = 'failed'
    result.message = 'the solver could not satisfy the constraints; check the starting positions and the values (e.g. a distance larger than a line can reach)'
  }

  for (const p of w.sketch_index.get_primitives()) {
    if (p.type === 'point' && p.id.startsWith('p:')) result.points[p.id.slice(2)] = [round(p.x), round(p.y)]
  }
  const P = (id: string) => result.points[id]
  for (const e of s.entities) {
    if (e.kind === 'line') result.entities.push({ id: e.id, kind: 'line', a: P(e.a), b: P(e.b), construction: e.construction })
    else if (e.kind === 'circle') {
      const g = w.sketch_index.get_primitives().find((x) => x.id === `e:${e.id}`) as { radius: number }
      result.entities.push({ id: e.id, kind: 'circle', c: P(e.center), r: round(g.radius), construction: e.construction })
    } else {
      const c = P(e.center)
      const st = P(e.start)
      result.entities.push({ id: e.id, kind: 'arc', c, r: round(Math.hypot(st[0] - c[0], st[1] - c[1])), start: st, end: P(e.end), construction: e.construction })
    }
  }

  result.loops = findLoops(s, result)
  return result
}

function round(v: number) {
  return Math.round(v * 1e6) / 1e6
}

export function summarizeConstraint(c: SketchConstraint): string {
  switch (c.kind) {
    case 'horizontal':
    case 'vertical':
      return `${c.kind} ${c.line}`
    case 'point_on':
      return `${c.point} on ${c.on}`
    case 'midpoint':
      return `${c.point} midpoint of ${c.line}`
    case 'length':
      return `length ${c.line} = ${c.value}`
    case 'radius':
      return `radius ${c.of} = ${c.value}`
    case 'fix':
      return `fix ${c.point}${c.x !== undefined ? ` x=${c.x}` : ''}${c.y !== undefined ? ` y=${c.y}` : ''}`
    case 'symmetric':
      return `${c.a}, ${c.b} symmetric about ${c.about}`
    case 'distance':
    case 'distance_x':
    case 'distance_y':
    case 'angle':
      return `${c.kind} ${c.a}–${c.b} = ${c.value}`
    default:
      return `${c.kind} ${(c as { a: string }).a}, ${(c as { b: string }).b}`
  }
}

const key = (p: P2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`

/**
 * Finds closed loops among the non-construction entities: circles are loops
 * by themselves; lines and arcs are chained end to end. Coincident ends are
 * matched by position after solving, so loops form as soon as the solver
 * joins them.
 */
function findLoops(s: Sketch, solved: SolvedSketch): Loop[] {
  const loops: Loop[] = []
  const chainable: Extract<SolvedEntity, { kind: 'line' | 'arc' }>[] = []
  for (const e of solved.entities) {
    if (e.construction) continue
    if (e.kind === 'circle') loops.push({ entities: [e.id], segments: [{ kind: 'circle', c: e.c, r: e.r }], area: Math.PI * e.r * e.r })
    else chainable.push(e)
  }

  const ends = (e: (typeof chainable)[number]): [P2, P2] => (e.kind === 'line' ? [e.a, e.b] : [e.start, e.end])
  const used = new Set<string>()
  for (const first of chainable) {
    if (used.has(first.id)) continue
    const chain: { e: (typeof chainable)[number]; rev: boolean }[] = [{ e: first, rev: false }]
    const local = new Set([first.id])
    const start = key(ends(first)[0])
    let cur = key(ends(first)[1])
    let closed = cur === start
    while (!closed) {
      const next = chainable.find((e) => !used.has(e.id) && !local.has(e.id) && (key(ends(e)[0]) === cur || key(ends(e)[1]) === cur))
      if (!next) break
      const rev = key(ends(next)[1]) === cur
      chain.push({ e: next, rev })
      local.add(next.id)
      cur = key(ends(next)[rev ? 0 : 1])
      closed = cur === start
    }
    if (!closed) continue
    for (const id of local) used.add(id)

    const segments: Segment[] = chain.map(({ e, rev }) => {
      const [a, b] = ends(e)
      const [from, to] = rev ? [b, a] : [a, b]
      if (e.kind === 'line') return { kind: 'line', from, to }
      // Arc is CCW from start to end; its midpoint fixes the shape.
      const a0 = Math.atan2(e.start[1] - e.c[1], e.start[0] - e.c[0])
      let a1 = Math.atan2(e.end[1] - e.c[1], e.end[0] - e.c[0])
      if (a1 <= a0) a1 += 2 * Math.PI
      const am = (a0 + a1) / 2
      return { kind: 'arc', from, to, mid: [e.c[0] + e.r * Math.cos(am), e.c[1] + e.r * Math.sin(am)] }
    })
    loops.push({ entities: chain.map((c) => c.e.id), segments, area: Math.abs(polyArea(segments)) })
  }

  loops.sort((a, b) => b.area - a.area)
  return loops
}

function polyArea(segs: Segment[]): number {
  const pts: P2[] = []
  for (const s of segs) {
    if (s.kind === 'circle') return Math.PI * s.r * s.r
    pts.push(s.from)
    if (s.kind === 'arc') pts.push(s.mid)
  }
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

/** Whether loop b lies inside loop a (test one point of b against a's polygon). */
export function loopInside(inner: Loop, outer: Loop): boolean {
  const probe: P2 = inner.segments[0].kind === 'circle' ? [inner.segments[0].c[0] + inner.segments[0].r, inner.segments[0].c[1]] : inner.segments[0].from
  const poly: P2[] = []
  for (const s of outer.segments) {
    if (s.kind === 'circle') return Math.hypot(probe[0] - s.c[0], probe[1] - s.c[1]) < s.r
    poly.push(s.from)
    if (s.kind === 'arc') poly.push(s.mid)
  }
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > probe[1] !== yj > probe[1] && probe[0] < ((xj - xi) * (probe[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
