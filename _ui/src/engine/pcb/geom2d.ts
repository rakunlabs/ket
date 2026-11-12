// Plain 2D helpers shared by the router, DRC, placement and the clean-up
// passes. The scalar forms (numbers in, number out) do not allocate, for
// the router's inner loops; the [x, y] forms wrap them.

import type { Track } from '../doc'

export type XY = [number, number]
type Pt = { x: number; y: number }

/** Distance from (px, py) to the segment (ax, ay)–(bx, by). */
export function distPointSegXY(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

/** Even-odd point in polygon. */
export function insideXY(x: number, y: number, poly: Pt[]): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c
  }
  return c
}

/** Distance from a point to a polygon's edges (0 inside). */
export function distPolyXY(x: number, y: number, poly: Pt[]): number {
  if (insideXY(x, y, poly)) return 0
  let d = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    d = Math.min(d, distPointSegXY(x, y, a.x, a.y, b.x, b.y))
  }
  return d
}

/** Point to segment, [x, y] points. */
export const distPS = (p: XY, a: XY, c: XY) => distPointSegXY(p[0], p[1], a[0], a[1], c[0], c[1])

/** Segment to segment (0 when they cross), [x, y] points. */
export function distSS(a: XY, c: XY, p: XY, q: XY): number {
  const o = (u: XY, v: XY, w: XY) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])
  if (o(p, q, a) * o(p, q, c) < 0 && o(a, c, p) * o(a, c, q) < 0) return 0
  return Math.min(distPS(a, p, q), distPS(c, p, q), distPS(p, a, c), distPS(q, a, c))
}

/** Point in polygon, [x, y] point. */
export const insidePoly = (p: XY, poly: Pt[]) => insideXY(p[0], p[1], poly)

/** Distance from a segment to a polygon's edges, [x, y] points (not 0 inside: callers test that). */
export function distSegEdges(a: XY, c: XY, poly: Pt[]): number {
  let d = Infinity
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distSS(a, c, [poly[i].x, poly[i].y], [poly[(i + 1) % poly.length].x, poly[(i + 1) % poly.length].y]))
  return d
}

/**
 * Joins track pieces that share end points into one polyline, starting at
 * the piece end nearest to from. tol is how close ends must be to join.
 * Undefined when the pieces do not form one path.
 */
export function joinPieces(tracks: Track[], from: XY, tol: number): XY[] | undefined {
  const left = tracks.map((t) => [...t.points] as XY[])
  if (!left.length) return undefined
  const near = (p: XY, q: XY) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol
  let best = 0
  let flip = false
  let bd = Infinity
  left.forEach((p, i) => {
    for (const [end, f] of [[p[0], false], [p[p.length - 1], true]] as const) {
      const d = Math.hypot(end[0] - from[0], end[1] - from[1])
      if (d < bd) [bd, best, flip] = [d, i, f]
    }
  })
  let path = left.splice(best, 1)[0]
  if (flip) path.reverse()
  while (left.length) {
    const end = path[path.length - 1]
    const i = left.findIndex((p) => near(p[0], end) || near(p[p.length - 1], end))
    if (i < 0) return undefined
    const p = left.splice(i, 1)[0]
    if (!near(p[0], end)) p.reverse()
    path = path.concat(p.slice(1))
  }
  return path
}
