// Sketch commands. A model usually defines a whole sketch in one call
// (points, entities, constraints), or uses the shortcuts in add_to_sketch
// (rect, circle, slot, polygon) that create the entities and their obvious
// constraints at once. solve_sketch reports what is left to constrain.

import { z } from 'zod'

import type { Doc, Sketch, SketchConstraint, SketchEntity, SketchPoint } from './doc'
import { define } from './registry'
import { expr, ident, plane, vec2 } from './schema'
import { CONSTRAINT_KINDS, summarizeConstraint } from './sketch'

const sid = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'use letters, digits and _, e.g. "p1", "top"')

const point = z.object({
  id: sid,
  x: expr,
  y: expr,
  fixed: z.boolean().optional().describe('The solver will not move it'),
})

const entity = z.discriminatedUnion('kind', [
  z.object({ id: sid, kind: z.literal('line'), a: sid.describe('Start point id'), b: sid.describe('End point id'), construction: z.boolean().optional() }),
  z.object({ id: sid, kind: z.literal('circle'), center: sid, r: expr, construction: z.boolean().optional() }),
  z.object({
    id: sid,
    kind: z.literal('arc'),
    center: sid,
    start: sid,
    end: sid.describe('The arc runs counter-clockwise from start to end'),
    construction: z.boolean().optional(),
  }),
])

const ref = sid.describe('Point or entity id')

const constraint = z
  .object({
    kind: z.enum(CONSTRAINT_KINDS),
    a: ref.optional(),
    b: ref.optional(),
    line: sid.optional(),
    point: sid.optional(),
    on: sid.optional(),
    of: sid.optional(),
    about: ref.optional(),
    value: expr.optional().describe('mm, or degrees for angle'),
    x: expr.optional(),
    y: expr.optional(),
  })
  .describe(
    [
      'coincident {a,b points}',
      'horizontal|vertical {line}',
      'parallel|perpendicular {a,b lines}',
      'equal {a,b: lines → same length, circles/arcs → same radius}',
      'tangent {a,b: line+circle/arc or circle/arc pairs}',
      'point_on {point, on: line/circle/arc}',
      'midpoint {point, line}',
      'distance {a,b: point-point or point-line/circle, value}',
      'distance_x|distance_y {a,b points, value = b - a along u/v}',
      'length {line, value}',
      'radius {of: circle/arc, value}',
      'angle {a,b lines, value degrees}',
      'fix {point, x?, y?} (no x/y: keep where it is)',
      'symmetric {a,b points, about: point or line}',
    ].join('; '),
  )

const REQUIRED: Record<string, string[]> = {
  coincident: ['a', 'b'],
  horizontal: ['line'],
  vertical: ['line'],
  parallel: ['a', 'b'],
  perpendicular: ['a', 'b'],
  equal: ['a', 'b'],
  tangent: ['a', 'b'],
  point_on: ['point', 'on'],
  midpoint: ['point', 'line'],
  distance: ['a', 'b', 'value'],
  distance_x: ['a', 'b', 'value'],
  distance_y: ['a', 'b', 'value'],
  length: ['line', 'value'],
  radius: ['of', 'value'],
  angle: ['a', 'b', 'value'],
  fix: ['point'],
  symmetric: ['a', 'b', 'about'],
}

function toConstraint(c: z.infer<typeof constraint>, i: number): SketchConstraint {
  const missing = (REQUIRED[c.kind] ?? []).filter((k) => (c as Record<string, unknown>)[k] === undefined)
  if (missing.length) throw new Error(`constraint ${i + 1} (${c.kind}) needs ${missing.join(', ')}`)
  const out: Record<string, unknown> = { kind: c.kind }
  for (const k of [...(REQUIRED[c.kind] ?? []), 'x', 'y']) {
    const v = (c as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out as SketchConstraint
}

function clone(doc: Doc): Doc {
  const d = JSON.parse(JSON.stringify(doc)) as Doc
  if (!d.sketches) d.sketches = []
  return d
}

function getSketch(doc: Doc, name: string): Sketch {
  const s = doc.sketches.find((x) => x.name === name)
  if (!s) throw new Error(`no sketch "${name}"; sketches are: ${doc.sketches.map((x) => x.name).join(', ') || '(none)'}`)
  return s
}

function checkIds(s: Sketch) {
  const ids = new Set<string>()
  for (const p of s.points) {
    if (ids.has(p.id)) throw new Error(`sketch ${s.name}: id "${p.id}" is used twice`)
    ids.add(p.id)
  }
  for (const e of s.entities) {
    if (ids.has(e.id)) throw new Error(`sketch ${s.name}: id "${e.id}" is used twice`)
    ids.add(e.id)
  }
}

define({
  name: 'sketch',
  group: 'sketch',
  kind: 'mutate',
  description:
    'Create (or with replace: true redefine) a constrained 2D sketch on a plane. Plane coordinates (u, v): XY → (x, y) at z = offset, XZ → (x, z) at y = offset, YZ → (y, z) at x = offset. Points are starting guesses; constraints hold the intent and the solver moves the points. Lines and arcs that share points form closed outlines; loops inside loops become holes. Use parameters in values so the sketch follows the design. Shortcuts: add_to_sketch with rect/circle/slot/polygon. Then extrude or revolve it with sketch: "<name>".',
  args: z.object({
    name: ident.describe('Sketch name, e.g. "outline", "profile"'),
    plane,
    offset: expr.optional(),
    points: z.array(point).optional(),
    entities: z.array(entity).optional(),
    constraints: z.array(constraint).optional(),
    note: z.string().optional(),
    replace: z.boolean().optional(),
  }),
  examples: [
    {
      name: 'bracket',
      plane: 'XZ',
      points: [
        { id: 'o', x: 0, y: 0, fixed: true },
        { id: 'a', x: 40, y: 0 },
        { id: 'b', x: 40, y: 5 },
        { id: 'c', x: 5, y: 5 },
        { id: 'd', x: 5, y: 30 },
        { id: 'e', x: 0, y: 30 },
      ],
      entities: [
        { id: 'l1', kind: 'line', a: 'o', b: 'a' },
        { id: 'l2', kind: 'line', a: 'a', b: 'b' },
        { id: 'l3', kind: 'line', a: 'b', b: 'c' },
        { id: 'l4', kind: 'line', a: 'c', b: 'd' },
        { id: 'l5', kind: 'line', a: 'd', b: 'e' },
        { id: 'l6', kind: 'line', a: 'e', b: 'o' },
      ],
      constraints: [
        { kind: 'horizontal', line: 'l1' },
        { kind: 'vertical', line: 'l2' },
        { kind: 'horizontal', line: 'l3' },
        { kind: 'vertical', line: 'l4' },
        { kind: 'horizontal', line: 'l5' },
        { kind: 'vertical', line: 'l6' },
        { kind: 'length', line: 'l1', value: 'arm' },
        { kind: 'length', line: 'l6', value: 'height' },
        { kind: 'length', line: 'l2', value: 'thick' },
        { kind: 'length', line: 'l5', value: 'thick' },
      ],
    },
  ],
  apply(doc, a) {
    const next = clone(doc)
    const s: Sketch = {
      name: a.name,
      plane: a.plane,
      ...(a.offset !== undefined ? { offset: a.offset } : {}),
      points: (a.points ?? []) as SketchPoint[],
      entities: (a.entities ?? []) as SketchEntity[],
      constraints: (a.constraints ?? []).map(toConstraint),
      ...(a.note ? { note: a.note } : {}),
    }
    checkIds(s)
    const i = next.sketches.findIndex((x) => x.name === a.name)
    if (i >= 0) {
      if (!a.replace) throw new Error(`a sketch named "${a.name}" exists; use add_to_sketch to extend it, or replace: true to redefine it`)
      next.sketches[i] = s
      return { doc: next, summary: `replaced sketch ${a.name}` }
    }
    next.sketches.push(s)
    return { doc: next, summary: `added sketch ${a.name} on ${a.plane} (${s.points.length} points, ${s.entities.length} entities, ${s.constraints.length} constraints)` }
  },
})

const shape = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rect'),
    prefix: sid.describe('Id prefix for the created points/lines, e.g. "body" → body_p1, body_l1'),
    w: expr,
    h: expr,
    center: vec2.optional().describe('Center [u, v]; default [0,0]'),
    fix_center: z.boolean().optional().describe('Constrain the center position too (default true)'),
  }),
  z.object({
    kind: z.literal('circle'),
    prefix: sid,
    r: expr,
    center: vec2.optional(),
    fix_center: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('slot'),
    prefix: sid,
    length: expr.describe('Overall length including the round ends'),
    width: expr,
    center: vec2.optional(),
    fix_center: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('polygon'),
    prefix: sid,
    points: z.array(vec2).min(3).describe('Corners in order; lines are created between them and the outline is closed'),
    fix: z.boolean().optional().describe('Fix every corner where it is (default false)'),
  }),
])

define({
  name: 'add_to_sketch',
  group: 'sketch',
  kind: 'mutate',
  description:
    'Add to an existing sketch: shapes (rect, circle, slot, polygon, each fully constrained by its values and center), and/or raw points, entities and constraints. Use it for holes and cut-outs inside an outline, or to add constraints after solve_sketch reports degrees of freedom.',
  args: z.object({
    sketch: z.string(),
    shapes: z.array(shape).optional(),
    points: z.array(point).optional(),
    entities: z.array(entity).optional(),
    constraints: z.array(constraint).optional(),
  }),
  examples: [
    { sketch: 'plate', shapes: [{ kind: 'circle', prefix: 'hole1', r: 1.6, center: ['hole_x', 'hole_y'] }] },
    { sketch: 'bracket', constraints: [{ kind: 'fix', point: 'o', x: 0, y: 0 }] },
  ],
  apply(doc, a) {
    const next = clone(doc)
    const s = getSketch(next, a.sketch)
    const before = s.constraints.length
    for (const p of a.points ?? []) s.points.push(p as SketchPoint)
    for (const e of a.entities ?? []) s.entities.push(e as SketchEntity)
    for (const [i, c] of (a.constraints ?? []).entries()) s.constraints.push(toConstraint(c, before + i))
    const added: string[] = []
    for (const sh of a.shapes ?? []) {
      addShape(s, sh)
      added.push(`${sh.kind} ${sh.prefix}`)
    }
    checkIds(s)
    const parts = [
      added.length ? added.join(', ') : '',
      a.points?.length ? `${a.points.length} points` : '',
      a.entities?.length ? `${a.entities.length} entities` : '',
      a.constraints?.length ? `${a.constraints.length} constraints` : '',
    ].filter(Boolean)
    return { doc: next, summary: `sketch ${a.sketch}: added ${parts.join(', ') || 'nothing'}` }
  },
})

function neg(e: number | string): number | string {
  return typeof e === 'number' ? -e : `-(${e})`
}

function sum(a: unknown, b: number | string): number | string {
  if (typeof a === 'number' && typeof b === 'number') return a + b
  return `(${a as string}) + (${b})`
}

function addShape(s: Sketch, sh: z.infer<typeof shape>) {
  const P = (id: string, x: unknown, y: unknown, fixed?: boolean) => s.points.push({ id, x: x as never, y: y as never, ...(fixed ? { fixed } : {}) })
  const L = (id: string, a: string, b: string) => s.entities.push({ id, kind: 'line', a, b })
  const C = (c: SketchConstraint) => s.constraints.push(c)
  const n = sh.prefix
  const center = 'center' in sh && sh.center ? sh.center : [0, 0]
  const fixCenter = !('fix_center' in sh) || sh.fix_center !== false
  // Initial guesses: numbers where we can, else 0 (the solver moves them).
  const g = (e: unknown) => (typeof e === 'number' ? e : 0)
  const [cx, cy] = [g(center[0]), g(center[1])]

  switch (sh.kind) {
    case 'rect': {
      const [w, h] = [g(sh.w) || 10, g(sh.h) || 10]
      P(`${n}_p1`, cx - w / 2, cy - h / 2)
      P(`${n}_p2`, cx + w / 2, cy - h / 2)
      P(`${n}_p3`, cx + w / 2, cy + h / 2)
      P(`${n}_p4`, cx - w / 2, cy + h / 2)
      L(`${n}_bottom`, `${n}_p1`, `${n}_p2`)
      L(`${n}_right`, `${n}_p2`, `${n}_p3`)
      L(`${n}_top`, `${n}_p3`, `${n}_p4`)
      L(`${n}_left`, `${n}_p4`, `${n}_p1`)
      C({ kind: 'horizontal', line: `${n}_bottom` })
      C({ kind: 'horizontal', line: `${n}_top` })
      C({ kind: 'vertical', line: `${n}_left` })
      C({ kind: 'vertical', line: `${n}_right` })
      C({ kind: 'length', line: `${n}_bottom`, value: sh.w })
      C({ kind: 'length', line: `${n}_left`, value: sh.h })
      if (fixCenter) {
        P(`${n}_c`, cx, cy)
        s.entities.push({ id: `${n}_diag`, kind: 'line', a: `${n}_p1`, b: `${n}_p3`, construction: true })
        C({ kind: 'midpoint', point: `${n}_c`, line: `${n}_diag` })
        C({ kind: 'fix', point: `${n}_c`, x: center[0], y: center[1] })
      }
      break
    }
    case 'circle': {
      P(`${n}_c`, cx, cy)
      s.entities.push({ id: n, kind: 'circle', center: `${n}_c`, r: sh.r })
      C({ kind: 'radius', of: n, value: sh.r })
      if (fixCenter) C({ kind: 'fix', point: `${n}_c`, x: center[0], y: center[1] })
      break
    }
    case 'slot': {
      // Along u: two half circles joined by two lines, fully constrained.
      const len = g(sh.length) || 20
      const wid = g(sh.width) || 5
      const half = (len - wid) / 2
      const r = wid / 2
      const half_e = typeof sh.length === 'number' && typeof sh.width === 'number' ? (sh.length - sh.width) / 2 : `((${sh.length}) - (${sh.width}))/2`
      const r_e = typeof sh.width === 'number' ? sh.width / 2 : `(${sh.width})/2`
      P(`${n}_c1`, cx - half, cy)
      P(`${n}_c2`, cx + half, cy)
      P(`${n}_a`, cx - half, cy - r)
      P(`${n}_b`, cx + half, cy - r)
      P(`${n}_c`, cx + half, cy + r)
      P(`${n}_d`, cx - half, cy + r)
      L(`${n}_l1`, `${n}_a`, `${n}_b`)
      s.entities.push({ id: `${n}_arc2`, kind: 'arc', center: `${n}_c2`, start: `${n}_b`, end: `${n}_c` })
      L(`${n}_l2`, `${n}_c`, `${n}_d`)
      s.entities.push({ id: `${n}_arc1`, kind: 'arc', center: `${n}_c1`, start: `${n}_d`, end: `${n}_a` })
      // With arc_rules the ends lie on their arcs, so fixing the centers,
      // the radius of each arc and the x of each end makes it rigid.
      if (fixCenter) {
        C({ kind: 'fix', point: `${n}_c1`, x: sum(center[0], neg(half_e)), y: center[1] })
        C({ kind: 'fix', point: `${n}_c2`, x: sum(center[0], half_e), y: center[1] })
      } else {
        C({ kind: 'distance_y', a: `${n}_c1`, b: `${n}_c2`, value: 0 })
        C({ kind: 'distance_x', a: `${n}_c1`, b: `${n}_c2`, value: sum(half_e, half_e) })
      }
      C({ kind: 'radius', of: `${n}_arc1`, value: r_e })
      C({ kind: 'radius', of: `${n}_arc2`, value: r_e })
      for (const [pt, c] of [
        ['a', 'c1'],
        ['b', 'c2'],
        ['c', 'c2'],
        ['d', 'c1'],
      ] as const) {
        C({ kind: 'distance_x', a: `${n}_${c}`, b: `${n}_${pt}`, value: 0 })
      }
      break
    }
    case 'polygon': {
      sh.points.forEach((p, i) => P(`${n}_p${i + 1}`, p[0], p[1], sh.fix))
      for (let i = 0; i < sh.points.length; i++) L(`${n}_l${i + 1}`, `${n}_p${i + 1}`, `${n}_p${((i + 1) % sh.points.length) + 1}`)
      break
    }
  }
}

define({
  name: 'remove_from_sketch',
  group: 'sketch',
  kind: 'mutate',
  description:
    'Remove points, entities or constraints from a sketch. Constraints are referenced by their 1-based number as solve_sketch lists them. Removing a point also removes the entities and constraints using it.',
  args: z.object({
    sketch: z.string(),
    ids: z.array(z.string()).optional().describe('Point or entity ids'),
    constraints: z.array(z.number().int().positive()).optional().describe('1-based constraint numbers'),
  }),
  apply(doc, a) {
    const next = clone(doc)
    const s = getSketch(next, a.sketch)
    const drop = new Set(a.ids ?? [])
    for (const id of drop) {
      if (!s.points.some((p) => p.id === id) && !s.entities.some((e) => e.id === id)) throw new Error(`sketch ${a.sketch} has no point or entity "${id}"`)
    }
    // Entities that use a removed point go too.
    for (const e of s.entities) {
      const uses = e.kind === 'line' ? [e.a, e.b] : e.kind === 'circle' ? [e.center] : [e.center, e.start, e.end]
      if (uses.some((u) => drop.has(u))) drop.add(e.id)
    }
    const dropC = new Set((a.constraints ?? []).map((n) => n - 1))
    for (const n of dropC) if (n >= s.constraints.length) throw new Error(`sketch ${a.sketch} has ${s.constraints.length} constraints; there is no #${n + 1}`)
    s.constraints = s.constraints.filter((c, i) => {
      if (dropC.has(i)) return false
      return !Object.values(c).some((v) => typeof v === 'string' && drop.has(v))
    })
    s.points = s.points.filter((p) => !drop.has(p.id))
    s.entities = s.entities.filter((e) => !drop.has(e.id))
    return { doc: next, summary: `sketch ${a.sketch}: removed ${[...drop].join(', ')}${dropC.size ? ` constraints ${[...dropC].map((n) => n + 1).join(', ')}` : ''}` }
  },
})

define({
  name: 'delete_sketch',
  group: 'sketch',
  kind: 'mutate',
  description: 'Delete a sketch. Fails while a feature uses it.',
  args: z.object({ name: z.string() }),
  apply(doc, a) {
    const next = clone(doc)
    getSketch(next, a.name)
    const users = next.features.filter((f) => (f as { sketch?: string }).sketch === a.name).map((f) => f.name)
    if (users.length) throw new Error(`sketch ${a.name} is used by ${users.join(', ')}; delete or change them first`)
    next.sketches = next.sketches.filter((s) => s.name !== a.name)
    return { doc: next, summary: `deleted sketch ${a.name}` }
  },
})

define({
  name: 'solve_sketch',
  group: 'sketch',
  kind: 'query',
  description:
    'Solve a sketch and report: status (solved / conflict / redundant / failed), degrees of freedom left (0 = fully constrained; aim for 0 so parameter changes behave), conflicting or redundant constraints by number, solved point positions, and the closed loops found (what extrude/revolve will use).',
  args: z.object({ name: z.string() }),
  async run(ctx, a) {
    const s = getSketch(ctx.doc, a.name)
    const sk = await ctx.kernel.sketch(a.name)
    return {
      name: s.name,
      plane: s.plane,
      status: sk.status,
      ok: sk.ok,
      dof: sk.dof,
      message: sk.message,
      hint:
        sk.ok && sk.dof > 0
          ? `${sk.dof} degree(s) of freedom left: add dimensions (length, distance, radius) or fix points so the shape cannot drift.`
          : undefined,
      loops: sk.loops.map((l) => ({ entities: l.entities, area: Math.round(l.area * 1000) / 1000 })),
      points: sk.points,
      constraints: s.constraints.map((c, i) => `#${i + 1} ${summarizeConstraint(c)}${sk.conflicting?.includes(i) ? '  ← CONFLICT' : ''}${sk.redundant?.includes(i) ? '  ← redundant' : ''}`),
    }
  },
})
