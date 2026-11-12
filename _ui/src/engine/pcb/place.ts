// Automatic placement: put parts where their connections are short, the
// way calculate-packing (tscircuit, MIT) and the classic constructive +
// pairwise-swap placers do it. Parts that are fixed (edge connectors, parts
// the user lists in keep, and anything placed when only some refs are asked
// for) stay; the others go one by one, largest and most connected first, to
// the free spot (no courtyard overlap with a gap, inside the board with a
// margin) that minimises the squared length of their ratsnest to what is
// already placed, trying 0/90/180/270°. Then a few improvement passes move
// each part again with the rest fixed and swap equal-sized parts when it
// shortens the nets. Deterministic: same board, same answer.

import type { Pcb } from '../doc'
import type { ResolvedBoard } from './board'
import { insideXY } from './geom2d'

type P = { x: number; y: number }

export interface PlaceOptions {
  /** Parts to place (default every part that is not an edge connector). */
  refs?: string[]
  /** Parts that must stay where they are. */
  keep?: string[]
  /** Gap between courtyards, mm (default 0.5: room for a track). */
  gap?: number
  /** Margin from the board edge, mm (default 1). */
  margin?: number
  /** Grid of candidate positions, mm (default 0.5). */
  step?: number
  /** Only 0° and 180° (keeps text upright and parts in rows). */
  rotations?: number[]
}

export interface Placement {
  ref: string
  at: [number, number]
  rotation: number
}

interface Part {
  ref: string
  fixed: boolean
  /** Courtyard half extents at rotation 0, around the part origin: [minX, minY, maxX, maxY]. */
  box: [number, number, number, number]
  /** Pads relative to the part origin at rotation 0 (bottom parts already mirrored). */
  pads: { pin: string; x: number; y: number; net?: string }[]
  at: P
  rot: number
}

const rotP = (x: number, y: number, deg: number): P => {
  const a = (deg * Math.PI) / 180
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) }
}

function rotBox(b: [number, number, number, number], deg: number): [number, number, number, number] {
  const cs = [rotP(b[0], b[1], deg), rotP(b[2], b[1], deg), rotP(b[2], b[3], deg), rotP(b[0], b[3], deg)]
  return [Math.min(...cs.map((c) => c.x)), Math.min(...cs.map((c) => c.y)), Math.max(...cs.map((c) => c.x)), Math.max(...cs.map((c) => c.y))]
}


function distEdge(x: number, y: number, poly: P[]): number {
  let d = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0
    d = Math.min(d, Math.hypot(x - a.x - t * dx, y - a.y - t * dy))
  }
  return d
}

/** True when an axis-aligned box and a polygon overlap (a corner inside the other, or edges crossing). */
export function boxPolyOverlap([x0, y0, x1, y1]: [number, number, number, number], poly: P[]): boolean {
  const box: P[] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
  if (poly.some((q) => q.x > x0 && q.x < x1 && q.y > y0 && q.y < y1)) return true
  if (box.some((q) => insideXY(q.x, q.y, poly))) return true
  const cross = (a: P, b: P, c: P, d: P) => {
    const o = (p: P, q: P, r: P) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
  }
  for (let i = 0; i < 4; i++) for (let j = 0; j < poly.length; j++) if (cross(box[i], box[(i + 1) % 4], poly[j], poly[(j + 1) % poly.length])) return true
  return false
}

export function placeParts(pcb: Pcb, b: ResolvedBoard, opts: PlaceOptions = {}): { placements: Placement[]; before: number; after: number } {
  const gap = opts.gap ?? 0.5
  const margin = opts.margin ?? 1
  const step = opts.step ?? 0.5
  const rotations = opts.rotations ?? [0, 90, 180, 270]
  const want = opts.refs ? new Set(opts.refs) : undefined
  const keep = new Set(opts.keep ?? [])

  const netOf = new Map<string, string>()
  for (const n of pcb.nets) for (const p of n.pins) netOf.set(p, n.name)
  const parts: Part[] = b.components.map((c) => {
    const pads = c.footprint.pads.map((pd) => {
      const x = c.side === 'bottom' ? -pd.at.x : pd.at.x
      return { pin: pd.number, x, y: pd.at.y, net: netOf.get(`${c.ref}.${pd.number}`) }
    })
    const cy = c.footprint.courtyard.map((q) => ({ x: c.side === 'bottom' ? -q.x : q.x, y: q.y }))
    const xs = cy.length ? cy.map((q) => q.x) : pads.map((q) => q.x)
    const ys = cy.length ? cy.map((q) => q.y) : pads.map((q) => q.y)
    return {
      ref: c.ref,
      fixed: keep.has(c.ref) || (want ? !want.has(c.ref) : !!c.edge),
      box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      pads,
      at: { x: c.at.x, y: c.at.y },
      rot: c.rotation,
    }
  })
  const byRef = new Map(parts.map((p) => [p.ref, p]))

  const padsAt = (p: Part, at: P, rot: number) => p.pads.map((pd) => ({ ...pd, ...((r) => ({ x: at.x + r.x, y: at.y + r.y }))(rotP(pd.x, pd.y, rot)) }))
  const boxAt = (p: Part, at: P, rot: number): [number, number, number, number] => {
    const r = rotBox(p.box, rot)
    return [at.x + r[0], at.y + r[1], at.x + r[2], at.y + r[3]]
  }

  // Cost: squared distance from each pad to the nearest placed pad of its net (a star to the net's copper so far).
  const placed = new Set(parts.filter((p) => p.fixed).map((p) => p.ref))
  const netPads = (net: string, except: string) => {
    const out: P[] = []
    for (const ref of placed) {
      if (ref === except) continue
      const q = byRef.get(ref)!
      for (const pd of padsAt(q, q.at, q.rot)) if (pd.net === net) out.push(pd)
    }
    return out
  }
  const cost = (p: Part, at: P, rot: number) => {
    let c = 0
    const cache = new Map<string, P[]>()
    for (const pd of padsAt(p, at, rot)) {
      if (!pd.net) continue
      let others = cache.get(pd.net)
      if (!others) cache.set(pd.net, (others = netPads(pd.net, p.ref)))
      let best = Infinity
      for (const o of others) best = Math.min(best, (o.x - pd.x) ** 2 + (o.y - pd.y) ** 2)
      if (Number.isFinite(best)) c += best
    }
    return c
  }
  const total = () => {
    let s = 0
    for (const n of pcb.nets) {
      const pts: P[] = []
      for (const pin of n.pins) {
        const [ref, num] = [pin.slice(0, pin.indexOf('.')), pin.slice(pin.indexOf('.') + 1)]
        const q = byRef.get(ref)
        const pd = q && padsAt(q, q.at, q.rot).find((x) => x.pin === num)
        if (pd) pts.push(pd)
      }
      // Minimum spanning tree length.
      const inTree = [0]
      const left = pts.map((_, i) => i).slice(1)
      while (left.length) {
        let bi = 0
        let bd = Infinity
        for (const [k, i] of left.entries()) for (const j of inTree) {
          const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
          if (d < bd) {
            bd = d
            bi = k
          }
        }
        s += bd
        inTree.push(left.splice(bi, 1)[0])
      }
    }
    return Math.round(s * 100) / 100
  }
  const before = total()

  const fits = (p: Part, at: P, rot: number) => {
    const [x0, y0, x1, y1] = boxAt(p, at, rot)
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, (y0 + y1) / 2]] as [number, number][]) {
      if (!insideXY(x, y, b.outline) || distEdge(x, y, b.outline) < margin) return false
      for (const c of b.cutouts) if (insideXY(x, y, c) || distEdge(x, y, c) < margin) return false
    }
    for (const k of partKeepouts(p)) if (boxPolyOverlap([x0 - gap, y0 - gap, x1 + gap, y1 + gap], k.polygon)) return false
    for (const h of b.holes) if (h.at.x > x0 - h.d / 2 - gap && h.at.x < x1 + h.d / 2 + gap && h.at.y > y0 - h.d / 2 - gap && h.at.y < y1 + h.d / 2 + gap) return false
    for (const ref of placed) {
      if (ref === p.ref) continue
      const q = byRef.get(ref)!
      const [a0, b0, a1, b1] = boxAt(q, q.at, q.rot)
      if (x0 < a1 + gap && x1 > a0 - gap && y0 < b1 + gap && y1 > b0 - gap) return false
    }
    return true
  }

  // Keep-outs that forbid parts, on the side a part sits on (F.Cu: top, B.Cu: bottom; inner layers count for both).
  const sideOf = new Map(b.components.map((c) => [c.ref, c.side]))
  const partKeepouts = (p: Part) => b.keepouts.filter((k) => k.forbid.has('parts') && k.layers.some((l) => l !== (sideOf.get(p.ref) === 'bottom' ? 'F.Cu' : 'B.Cu')))
  const xs = b.outline.map((q) => q.x)
  const ys = b.outline.map((q) => q.y)
  const [bx0, by0, bx1, by1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  const centre: P = { x: (bx0 + bx1) / 2, y: (by0 + by1) / 2 }

  /** The best free spot for p (rest as placed now), or undefined. */
  const bestSpot = (p: Part): { at: P; rot: number; c: number } | undefined => {
    let best: { at: P; rot: number; c: number } | undefined
    const connected = p.pads.some((pd) => pd.net && netPads(pd.net, p.ref).length)
    for (const rot of rotations) {
      for (let y = by0; y <= by1; y += step)
        for (let x = bx0; x <= bx1; x += step) {
          const at = { x: Math.round(x / step) * step, y: Math.round(y / step) * step }
          if (!fits(p, at, rot)) continue
          // Unconnected so far: near the middle. Ties: smaller rotation, nearer the middle.
          const c = (connected ? cost(p, at, rot) : 0) + 1e-3 * ((at.x - centre.x) ** 2 + (at.y - centre.y) ** 2) + rot * 1e-6
          if (!best || c < best.c) best = { at, rot, c }
        }
    }
    return best
  }

  // Constructive: most connected to what is placed (and largest) first.
  const movable = parts.filter((p) => !p.fixed)
  const area = (p: Part) => (p.box[2] - p.box[0]) * (p.box[3] - p.box[1])
  const links = (p: Part) => p.pads.filter((pd) => pd.net).length
  const todo = [...movable]
  const failed: string[] = []
  while (todo.length) {
    todo.sort((a, c) => {
      const conn = (p: Part) => p.pads.filter((pd) => pd.net && netPads(pd.net, p.ref).length).length
      return conn(c) - conn(a) || area(c) * links(c) - area(a) * links(a) || a.ref.localeCompare(c.ref)
    })
    const p = todo.shift()!
    const s = bestSpot(p)
    if (!s) {
      failed.push(p.ref)
      continue
    }
    p.at = s.at
    p.rot = s.rot
    placed.add(p.ref)
  }

  // Improvement: move each part again with the others fixed; swap same-size parts.
  for (let pass = 0; pass < 3; pass++) {
    let better = false
    for (const p of movable) {
      if (!placed.has(p.ref)) continue
      const now = cost(p, p.at, p.rot)
      const s = bestSpot(p)
      if (s && s.c < now - 1e-6 && (s.at.x !== p.at.x || s.at.y !== p.at.y || s.rot !== p.rot)) {
        p.at = s.at
        p.rot = s.rot
        better = true
      }
    }
    for (let i = 0; i < movable.length; i++)
      for (let j = i + 1; j < movable.length; j++) {
        const [p, q] = [movable[i], movable[j]]
        if (!placed.has(p.ref) || !placed.has(q.ref) || Math.abs(area(p) - area(q)) > 0.05 * Math.max(area(p), area(q))) continue
        const was = total()
        ;[p.at, q.at] = [q.at, p.at]
        if (!fits(p, p.at, p.rot) || !fits(q, q.at, q.rot) || total() >= was - 1e-6) [p.at, q.at] = [q.at, p.at]
        else better = true
      }
    if (!better) break
  }

  if (failed.length) throw new Error(`no room for ${failed.join(', ')} on the board (gap ${gap} mm, margin ${margin} mm); make the board bigger, lower gap, or place some by hand`)
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  return {
    placements: movable.map((p) => ({ ref: p.ref, at: [r3(p.at.x), r3(p.at.y)] as [number, number], rotation: ((p.rot % 360) + 360) % 360 })),
    before,
    after: total(),
  }
}
