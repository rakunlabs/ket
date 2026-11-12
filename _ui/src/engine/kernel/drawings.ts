// 2D drawings for features: profiles, solved sketches, board polygons, sweep paths and decals.

import * as R from 'replicad'
import type { Edge } from 'replicad'

import type { Decal, Expr, Feature, Plane } from '../doc'
import { num } from '../expr'
import { type Loop, type SolvedSketch, loopInside } from '../sketch'
import { vec } from './placement'
import { add3, dot3, kernelMessage, len3, mul3, norm3, round, sub3 } from './shapes'
import type { ResolvedDecal, SketchFrame, V3 } from './types'

/** A 2D outline from a profile (rect, circle, slot, polygon). */
export function resolveDecal(d: Decal, params: Map<string, number>): ResolvedDecal {
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
export function profileDrawing(p: NonNullable<Extract<Feature, { type: 'extrude' }>['profile']>, params: Map<string, number>, what: string): R.Drawing {
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

export function baseProfileDrawing(p: NonNullable<Extract<Feature, { type: 'extrude' }>['profile']>, params: Map<string, number>, what: string): R.Drawing {
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

export function loopDrawing(loop: Loop): R.Drawing {
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
export function sketchDrawing(sk: SolvedSketch, what: string): R.Drawing {
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
export function onPlane(d: R.Drawing, plane: Plane, offset: number): R.Sketch | R.Sketches {
  const flip = plane === 'XZ' ? -1 : 1
  return d.sketchOnPlane(plane, offset * flip) as R.Sketch | R.Sketches
}

/** A drawing placed on a sketch frame (a face): (u, v) of the drawing along frame.u and frame.v. */
export function onFrame(d: R.Drawing, frame: SketchFrame): R.Sketch | R.Sketches {
  return d.sketchOnPlane(new R.Plane(frame.origin, frame.u, frame.normal)) as R.Sketch | R.Sketches
}

export const PLANE_AXES: Record<Plane, ['X' | 'Y' | 'Z', 'X' | 'Y' | 'Z', 'X' | 'Y' | 'Z']> = {
  XY: ['X', 'Y', 'Z'],
  XZ: ['X', 'Z', 'Y'],
  YZ: ['Y', 'Z', 'X'],
}
/**
 * A sweep path: straight segments through the points, with each inner
 * corner rounded to radius bend (0 = sharp corners).
 */
export function pathWire(pts: V3[], bend: number, what: string): R.Wire {
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
export function polyDrawing(poly: { x: number; y: number }[]): R.Drawing {
  let pen = R.draw([poly[0].x, poly[0].y])
  for (const p of poly.slice(1)) pen = pen.lineTo([p.x, p.y])
  return pen.close()
}
