// Polygon booleans and offsets over Clipper2 (integer coordinates, 1 nm).
// Rings are P[]; a region list is outer rings (positive area) and holes
// (negative area) in Clipper's order.

import { Clipper, EndType, FillRule, JoinType, Path64, Paths64, Point64 } from 'clipper2-js'

import type { P } from '../doc'

const S = 1e6

export type Ring = P[]

export function toPaths(rings: Ring[]): Paths64 {
  const out = new Paths64()
  for (const r of rings) {
    if (r.length < 2) continue
    const p = new Path64()
    for (const q of r) p.push(new Point64(Math.round(q.x * S), Math.round(q.y * S)))
    out.push(p)
  }
  return out
}

export function fromPaths(paths: Paths64): Ring[] {
  return paths.map((p) => p.map((q) => ({ x: q.x / S, y: q.y / S })))
}

/**
 * Unions independent shapes. Each input ring is one solid shape (pads,
 * strokes, disks), so every ring is made counter-clockwise first. Pass
 * regions with holes through unionRegions instead.
 */
export function union(rings: Ring[]): Ring[] {
  return fromPaths(Clipper.Union(toPaths(ccw(rings)), undefined, FillRule.NonZero))
}

/** Unions rings that are already oriented (outers CCW, holes CW). */
export function unionRegions(rings: Ring[]): Ring[] {
  return fromPaths(Clipper.Union(toPaths(rings), undefined, FillRule.NonZero))
}

export function difference(a: Ring[], b: Ring[]): Ring[] {
  return fromPaths(Clipper.Difference(toPaths(a), toPaths(b), FillRule.NonZero))
}

export function intersect(a: Ring[], b: Ring[]): Ring[] {
  return fromPaths(Clipper.Intersect(toPaths(a), toPaths(b), FillRule.NonZero))
}

/** Every ring counter-clockwise, so NonZero unions add them up. */
function ccw(rings: Ring[]): Ring[] {
  return rings.map((r) => (area(r) < 0 ? r.slice().reverse() : r))
}

/**
 * Grows (d > 0) or shrinks closed polygons with round corners.
 *
 * clipper2-js's InflatePaths gets round joins wrong (it under-grows), so
 * growing is a Minkowski sum built by hand: the polygon, a rectangle along
 * every edge and a circumscribed disk at every vertex, unioned. Shrinking
 * subtracts the same band from the polygon. Both err on the safe side.
 */
export function offset(rings: Ring[], d: number): Ring[] {
  if (!rings.length || d === 0) return rings
  const band: Ring[] = []
  const r = Math.abs(d)
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const l = Math.hypot(dx, dy)
      band.push(circle(a, r, 16))
      if (l < 1e-9) continue
      const nx = (-dy / l) * r
      const ny = (dx / l) * r
      band.push([
        { x: a.x + nx, y: a.y + ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny },
        { x: a.x - nx, y: a.y - ny },
      ])
    }
  }
  // Outer rings positive and holes negative as given: NonZero keeps holes.
  const P = toPaths(rings)
  const B = Clipper.Union(toPaths(ccw(band)), undefined, FillRule.NonZero)
  const out = d > 0 ? Clipper.Union(P, B, FillRule.NonZero) : Clipper.Difference(P, B, FillRule.NonZero)
  return fromPaths(out)
}

/** A stroked open polyline with round ends, as polygons. */
export function stroke(points: P[], width: number): Ring[] {
  const r = width / 2
  if (points.length < 2) {
    const c = points[0]
    return c ? [circle(c, r)] : []
  }
  const parts: Ring[] = []
  for (let i = 0; i < points.length; i++) {
    parts.push(circle(points[i], r, 16))
    if (i + 1 >= points.length) continue
    const a = points[i]
    const b = points[i + 1]
    const l = Math.hypot(b.x - a.x, b.y - a.y)
    if (l < 1e-9) continue
    const nx = (-(b.y - a.y) / l) * r
    const ny = ((b.x - a.x) / l) * r
    parts.push([
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ])
  }
  return union(parts)
}

// Every exported ring list from Clipper is oriented: outers CCW, holes CW.

export function circle(c: P, r: number, n = 24): Ring {
  // Circumscribed so the polygon contains the true circle.
  const R = r / Math.cos(Math.PI / n)
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI
    return { x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) }
  })
}

export function area(r: Ring): number {
  let a = 0
  for (let i = 0; i < r.length; i++) {
    const p = r[i]
    const q = r[(i + 1) % r.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Groups outers with their holes: [[outer, ...holes], ...]. */
export function polygons(rings: Ring[]): Ring[][] {
  const outers = rings.filter((r) => area(r) > 0)
  const holes = rings.filter((r) => area(r) < 0)
  const groups = outers.map((o) => [o])
  for (const h of holes) {
    const g = groups.find((grp) => pointIn(h[0], grp[0]))
    if (g) g.push(h)
  }
  return groups
}

export function pointIn(p: P, poly: Ring): boolean {
  let r = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r
  }
  return r
}

/** Whether point p lies in a region given as [outer, ...holes]. */
export function inRegion(p: P, region: Ring[]): boolean {
  return pointIn(p, region[0]) && !region.slice(1).some((h) => pointIn(p, h))
}

/** Whether two regions share area. Each side is [outer, ...holes] or a set of rings. */
export function overlaps(a: Ring[], b: Ring[]): boolean {
  return Clipper.Intersect(toPaths(a), toPaths(b), FillRule.EvenOdd).length > 0
}
