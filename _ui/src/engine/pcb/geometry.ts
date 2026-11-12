// PCB geometry: component transforms, pad outlines in world space, the
// board outline, and distance helpers for DRC. Board coordinates are world
// X/Y in mm with y up; a bottom-side part is mirrored in x before rotating.

import { type Component, type Footprint, type LayerCount, type Pad, type P, copperLayersOf } from '../doc'
import { distPointSegXY, insideXY } from './geom2d'

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
  /** Kept separately from the diameter for backwards-compatible consumers. */
  drillPlated?: boolean
  drillSlot?: [P, P]
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
    // Stadium as a polygon around the true outline: each quarter arc becomes
    // edges tangent to it (vertices at radius r / cos(Δ/2), between the tangent
    // points), so clearances to the polygon are never less than to the real pad.
    const rx = pad.w / 2
    const ry = pad.h / 2
    const r = Math.min(rx, ry)
    const hx = rx - r
    const hy = ry - r
    const steps = 6
    const step = Math.PI / 2 / steps
    const R = r / Math.cos(step / 2)
    pts = []
    const arc = (cx: number, cy: number, a0: number) => {
      // Tangent point on the axis, then the outer vertices, then the next tangent point.
      pts.push({ x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) })
      for (let i = 0; i < steps; i++) {
        const a = a0 + (i + 0.5) * step
        pts.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) })
      }
      pts.push({ x: cx + r * Math.cos(a0 + Math.PI / 2), y: cy + r * Math.sin(a0 + Math.PI / 2) })
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
  if (pad.layer === 'through') return copperLayersOf(layers as LayerCount)
  const top = pad.layer === 'top'
  return [(side === 'bottom' ? !top : top) ? 'F.Cu' : 'B.Cu']
}

export function worldPads(c: Placed, layers: number): WorldPad[] {
  return c.footprint.pads.map((pad) => {
    let drillSlot: [P, P] | undefined
    if (pad.drill?.ends || (pad.drill?.slot ?? 0) > (pad.drill?.d ?? 0)) {
      const half = Math.max(0, ((pad.drill!.slot ?? pad.drill!.d) - pad.drill!.d) / 2)
      const local = pad.drill!.ends ?? (pad.w >= pad.h ? [{ x: -half, y: 0 }, { x: half, y: 0 }] : [{ x: 0, y: -half }, { x: 0, y: half }])
      drillSlot = local.map((p) => {
        const q = rot(p, pad.rotation)
        return toWorld(c, { x: pad.at.x + q.x, y: pad.at.y + q.y })
      }) as [P, P]
    }
    return {
      ref: c.ref,
      pin: pad.number,
      name: c.footprint.pins[pad.number],
      center: toWorld(c, pad.at),
      outline: padLocal(pad).map((p) => toWorld(c, p)),
      layers: copperOf(pad, c.side, layers),
      drill: pad.drill?.d,
      ...(pad.drill ? { drillPlated: pad.drill.plated } : {}),
      ...(drillSlot ? { drillSlot } : {}),
    }
  })
}

export function courtyard(c: Placed): Poly {
  return c.footprint.courtyard.map((p) => toWorld(c, p))
}

// ── Distances ─────────────────────────────────────────────────────────

export function distPointSeg(p: P, a: P, b: P): number {
  return distPointSegXY(p.x, p.y, a.x, a.y, b.x, b.y)
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
  return insideXY(p.x, p.y, poly)
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
