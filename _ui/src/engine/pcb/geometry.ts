// PCB geometry: component transforms, pad outlines in world space, the
// board outline, and distance helpers for DRC. Board coordinates are world
// X/Y in mm with y up; a bottom-side part is mirrored in x before rotating.

import type { Component, Footprint, Pad, P } from '../doc'

export type Poly = P[]

export interface Placed {
  ref: string
  at: P
  rotation: number
  side: 'top' | 'bottom'
  footprint: Footprint
}

export interface WorldPad {
  ref: string
  pin: string
  /** Pin name from the symbol, if any. */
  name?: string
  center: P
  outline: Poly
  /** Copper layers the pad is on. */
  layers: string[]
  drill?: number
  net?: string
}

export function rot(p: P, deg: number): P {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

/** Footprint-local point → board coordinates. */
export function toWorld(c: Placed, p: P): P {
  const m = c.side === 'bottom' ? { x: -p.x, y: p.y } : p
  const r = rot(m, c.rotation)
  return { x: c.at.x + r.x, y: c.at.y + r.y }
}

/** Pad outline in footprint coordinates (pad rotation applied). */
function padLocal(pad: Pad): Poly {
  let pts: P[]
  if (pad.shape === 'polygon' && pad.polygon?.length) {
    pts = pad.polygon
  } else if (pad.shape === 'circle' || pad.shape === 'oval') {
    // Stadium approximated by 16 points.
    const rx = pad.w / 2
    const ry = pad.h / 2
    const r = Math.min(rx, ry)
    const hx = rx - r
    const hy = ry - r
    pts = []
    const arc = (cx: number, cy: number, a0: number) => {
      for (let i = 0; i <= 4; i++) {
        const a = a0 + (i / 4) * (Math.PI / 2)
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
      }
    }
    arc(hx, hy, 0)
    arc(-hx, hy, Math.PI / 2)
    arc(-hx, -hy, Math.PI)
    arc(hx, -hy, (3 * Math.PI) / 2)
  } else {
    const x = pad.w / 2
    const y = pad.h / 2
    pts = [
      { x: -x, y: -y },
      { x, y: -y },
      { x, y },
      { x: -x, y },
    ]
  }
  return pts.map((p) => {
    const q = rot(p, pad.rotation)
    return { x: pad.at.x + q.x, y: pad.at.y + q.y }
  })
}

const copperOf = (pad: Pad, side: 'top' | 'bottom', layers: number): string[] => {
  if (pad.layer === 'through') return layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu']
  const top = pad.layer === 'top'
  return [(side === 'bottom' ? !top : top) ? 'F.Cu' : 'B.Cu']
}

export function worldPads(c: Placed, layers: number): WorldPad[] {
  return c.footprint.pads.map((pad) => ({
    ref: c.ref,
    pin: pad.number,
    name: c.footprint.pins[pad.number],
    center: toWorld(c, pad.at),
    outline: padLocal(pad).map((p) => toWorld(c, p)),
    layers: copperOf(pad, c.side, layers),
    drill: pad.drill?.d,
  }))
}

export function courtyard(c: Placed): Poly {
  return c.footprint.courtyard.map((p) => toWorld(c, p))
}

// ── Distances ─────────────────────────────────────────────────────────

export function distPointSeg(p: P, a: P, b: P): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function segsIntersect(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = o(c, d, a)
  const d2 = o(c, d, b)
  const d3 = o(a, b, c)
  const d4 = o(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

export function distSegSeg(a: P, b: P, c: P, d: P): number {
  if (segsIntersect(a, b, c, d)) return 0
  return Math.min(distPointSeg(a, c, d), distPointSeg(b, c, d), distPointSeg(c, a, b), distPointSeg(d, a, b))
}

export function inside(p: P, poly: Poly): boolean {
  let r = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r
  }
  return r
}

/** Minimum distance between two polygons (0 when they overlap). */
export function distPolyPoly(a: Poly, b: Poly): number {
  if (inside(a[0], b) || inside(b[0], a)) return 0
  let m = Infinity
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i]
    const a2 = a[(i + 1) % a.length]
    for (let j = 0; j < b.length; j++) {
      m = Math.min(m, distSegSeg(a1, a2, b[j], b[(j + 1) % b.length]))
      if (m === 0) return 0
    }
  }
  return m
}

/** Minimum distance from a segment to a polygon (0 when touching/inside). */
export function distSegPoly(a: P, b: P, poly: Poly): number {
  if (inside(a, poly) || inside(b, poly)) return 0
  let m = Infinity
  for (let i = 0; i < poly.length; i++) m = Math.min(m, distSegSeg(a, b, poly[i], poly[(i + 1) % poly.length]))
  return m
}

export function bboxOf(pts: P[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

export function polyArea(p: Poly): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[i]
    const r = p[(i + 1) % p.length]
    a += q.x * r.y - r.x * q.y
  }
  return a / 2
}

export type { Component }
