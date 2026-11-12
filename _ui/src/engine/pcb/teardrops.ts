// Teardrops: a smooth widening where a track meets a pad or a via, so the
// joint survives drilling offsets and thermal stress. They are derived from
// the copper when the board is resolved (never stored), so they follow
// every track edit, and drawn as plain copper regions everywhere else
// (Gerber, 3D, the board view, DRC).

import type { Pcb } from '../doc'
import type { ResolvedBoard } from './board'
import type { Poly } from './geometry'
import { distPolyXY, insideXY } from './geom2d'

export interface Teardrops {
  /** Size along the track, as a multiple of the pad/via size it meets (default 1). */
  length?: number
  /** Width where it meets the pad, as a fraction of the pad/via size (default 0.9). */
  width?: number
}

export interface Teardrop {
  layer: string
  net: string
  /** Closed outline, board mm. */
  outline: Poly
  /** What it joins: "track 3 → U1.2" or "track 3 → via 2". */
  joins: string
}

type XY = { x: number; y: number }

const sub = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y })
const len = (a: XY) => Math.hypot(a.x, a.y)

/**
 * One teardrop from a track entering a round copper target (centre c,
 * size s = diameter, or the pad's smaller side). The drop is a trapezoid
 * with curved sides from the track (its width) to a width × s chord inside
 * the target, sampled as a polygon.
 */
function drop(toward: XY, c: XY, s: number, w: number, o: Required<Teardrops>): Poly | undefined {
  // Direction from the target into the track.
  const d0 = sub(toward, c)
  const dl = len(d0)
  if (dl < 1e-6) return undefined
  const u = { x: d0.x / dl, y: d0.y / dl }
  const n = { x: -u.y, y: u.x }
  const L = s * o.length
  // The track must run straight for the drop's length, else the drop would sit off it.
  if (dl < s / 2 + L * 0.5) return undefined
  const half0 = (s * o.width) / 2
  const half1 = w / 2
  if (half0 <= half1 + 1e-3) return undefined
  // From the target's center (well inside it) out to s/2 + L along the track.
  const base = { x: c.x, y: c.y }
  const reach = s / 2 + L
  const steps = 10
  const left: XY[] = []
  const right: XY[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const along = (s / 2) * 0.2 + (reach - (s / 2) * 0.2) * t
    // Concave flank: wide at the target, easing into the track width (cubic ease-out).
    const k = 1 - (1 - t) ** 2
    const half = half0 + (half1 - half0) * k
    const at = { x: base.x + u.x * along, y: base.y + u.y * along }
    left.push({ x: at.x + n.x * half, y: at.y + n.y * half })
    right.push({ x: at.x - n.x * half, y: at.y - n.y * half })
  }
  return [...left, ...right.reverse()]
}

/** Teardrops for every track end that lands on a pad or a via of its net. */
export function teardrops(pcb: Pcb, b: ResolvedBoard): Teardrop[] {
  if (!pcb.teardrops) return []
  const o: Required<Teardrops> = { length: pcb.teardrops.length ?? 1, width: pcb.teardrops.width ?? 0.9 }
  const out: Teardrop[] = []
  pcb.tracks.forEach((t, ti) => {
    if (t.points.length < 2) return
    const ends: [XY, XY][] = [
      [{ x: t.points[0][0], y: t.points[0][1] }, { x: t.points[1][0], y: t.points[1][1] }],
      [{ x: t.points[t.points.length - 1][0], y: t.points[t.points.length - 1][1] }, { x: t.points[t.points.length - 2][0], y: t.points[t.points.length - 2][1] }],
    ]
    for (const [end, toward] of ends) {
      // A via at the end.
      const vi = pcb.vias.findIndex((v) => v.net === t.net && Math.hypot(v.at[0] - end.x, v.at[1] - end.y) < v.diameter / 2)
      if (vi >= 0) {
        const v = pcb.vias[vi]
        const poly = drop(toward, { x: v.at[0], y: v.at[1] }, v.diameter, t.width, o)
        if (poly) out.push({ layer: t.layer, net: t.net, outline: poly, joins: `track ${ti + 1} → via ${vi + 1}` })
        continue
      }
      // A pad of its net on this layer, the end inside it. Round (through-hole) pads and small SMD pads get one.
      const pad = b.pads.find((p) => p.net === t.net && p.layers.includes(t.layer) && (insideXY(end.x, end.y, p.outline) || distPolyXY(end.x, end.y, p.outline) < 1e-3))
      if (!pad) continue
      const xs = pad.outline.map((q) => q.x)
      const ys = pad.outline.map((q) => q.y)
      const size = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
      // A track as wide as the pad gains nothing.
      if (size < t.width * 1.3) continue
      const poly = drop(toward, pad.center, size, t.width, o)
      if (poly) out.push({ layer: t.layer, net: t.net, outline: poly, joins: `track ${ti + 1} → ${pad.ref}.${pad.pin}` })
    }
  })
  return out
}

