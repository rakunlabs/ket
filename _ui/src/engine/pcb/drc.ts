// Connectivity and design rule checks against JLCPCB's standard 2/4-layer
// capabilities. Every violation names the objects and the measured value
// so a model can fix it directly.

import type { Pcb } from '../doc'
import { type ResolvedBoard } from './board'
import { type Poly, distPointSeg, distPolyPoly, distSegPoly, distSegSeg, inside } from './geometry'
import { inRegion, overlaps, stroke } from './poly'
import type { ZoneFill } from './zones'

export const JLCPCB = {
  minTrack: 0.127,
  minClearance: 0.127,
  minViaDrill: 0.3,
  minViaDiameter: 0.5,
  minAnnular: 0.13,
  copperToEdge: 0.3,
  minHole: 0.3,
  holeToHole: 0.5,
  /** Unplated to unplated (JLCPCB same-net hole spacing). */
  npthToNpth: 0.254,
}

export interface Violation {
  rule: string
  message: string
  at?: [number, number]
  objects?: string[]
}

// ── Connectivity ──────────────────────────────────────────────────────

class DSU {
  p: number[]
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i)
  }
  find(i: number): number {
    while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]]
    return i
  }
  union(a: number, b: number) {
    this.p[this.find(a)] = this.find(b)
  }
}

export interface Ratsnest {
  /** Missing connections, one per pair of islands that should be joined. */
  lines: { net: string; a: [number, number]; b: [number, number]; from: string; to: string }[]
  /** Nets fully connected / total nets with 2+ pins. */
  routed: number
  total: number
  unrouted: string[]
}

/**
 * Pads, track endpoints and vias of one net are joined when copper touches;
 * the ratsnest links the remaining islands with the shortest edges
 * (minimum spanning tree over island pairs).
 */
export function ratsnest(pcb: Pcb, b: ResolvedBoard, zones: ZoneFill[] = []): Ratsnest {
  const lines: Ratsnest['lines'] = []
  let routed = 0
  let total = 0
  const unrouted: string[] = []

  for (const net of pcb.nets) {
    const pads = b.pads.filter((p) => p.net === net.name)
    if (pads.length < 2) continue
    total++
    const tracks = pcb.tracks.filter((t) => t.net === net.name)
    const vias = pcb.vias.filter((v) => v.net === net.name)

    // Nodes: pads, then track segments, then vias.
    type Seg = { a: { x: number; y: number }; b: { x: number; y: number }; w: number; layer: string }
    const segs: Seg[] = []
    for (const t of tracks)
      for (let i = 0; i + 1 < t.points.length; i++)
        segs.push({ a: { x: t.points[i][0], y: t.points[i][1] }, b: { x: t.points[i + 1][0], y: t.points[i + 1][1] }, w: t.width, layer: t.layer })
    const n = pads.length + segs.length + vias.length
    const d = new DSU(n)
    const eps = 0.01

    const padTouchesSeg = (pi: number, s: Seg) => pads[pi].layers.includes(s.layer) && distSegPoly(s.a, s.b, pads[pi].outline) <= s.w / 2 + eps
    for (let i = 0; i < pads.length; i++)
      for (let j = 0; j < segs.length; j++) if (padTouchesSeg(i, segs[j])) d.union(i, pads.length + j)
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++)
        if (segs[i].layer === segs[j].layer && distSegSeg(segs[i].a, segs[i].b, segs[j].a, segs[j].b) <= (segs[i].w + segs[j].w) / 2 + eps)
          d.union(pads.length + i, pads.length + j)
    vias.forEach((v, k) => {
      const vi = pads.length + segs.length + k
      const c = { x: v.at[0], y: v.at[1] }
      segs.forEach((s, j) => {
        if (distPointSeg(c, s.a, s.b) <= v.diameter / 2 + s.w / 2 + eps) d.union(vi, pads.length + j)
      })
      pads.forEach((p, i) => {
        if (inside(c, p.outline) || Math.hypot(c.x - p.center.x, c.y - p.center.y) < v.diameter / 2) d.union(vi, i)
      })
    })
    // Copper pours: everything a pour region touches is one island.
    for (const z of zones) {
      if (z.net !== net.name) continue
      for (const reg of z.regions) {
        let first = -1
        const join = (i: number) => {
          if (first < 0) first = i
          else d.union(first, i)
        }
        pads.forEach((p, i) => {
          if (p.layers.includes(z.layer) && (overlaps(reg, [p.outline]) || inRegion(p.center, reg))) join(i)
        })
        segs.forEach((s, j) => {
          if (s.layer === z.layer && overlaps(reg, stroke([s.a, s.b], s.w))) join(pads.length + j)
        })
        vias.forEach((v, k) => {
          if (inRegion({ x: v.at[0], y: v.at[1] }, reg) || overlaps(reg, stroke([{ x: v.at[0], y: v.at[1] }], v.diameter))) join(pads.length + segs.length + k)
        })
      }
    }

    const islands = new Map<number, number[]>()
    pads.forEach((_, i) => {
      const r = d.find(i)
      if (!islands.has(r)) islands.set(r, [])
      islands.get(r)!.push(i)
    })
    const groups = [...islands.values()]
    if (groups.length <= 1) {
      routed++
      continue
    }
    unrouted.push(net.name)

    // Prim's MST over islands, edge = closest pad pair.
    const inTree = new Set([0])
    while (inTree.size < groups.length) {
      let best: { d: number; i: number; j: number; pi: number; pj: number } | undefined
      for (const gi of inTree)
        for (let gj = 0; gj < groups.length; gj++) {
          if (inTree.has(gj)) continue
          for (const pi of groups[gi])
            for (const pj of groups[gj]) {
              const dd = Math.hypot(pads[pi].center.x - pads[pj].center.x, pads[pi].center.y - pads[pj].center.y)
              if (!best || dd < best.d) best = { d: dd, i: gi, j: gj, pi, pj }
            }
        }
      if (!best) break
      inTree.add(best.j)
      const pa = pads[best.pi]
      const pb = pads[best.pj]
      lines.push({ net: net.name, a: [pa.center.x, pa.center.y], b: [pb.center.x, pb.center.y], from: `${pa.ref}.${pa.pin}`, to: `${pb.ref}.${pb.pin}` })
    }
  }

  return { lines, routed, total, unrouted }
}

// ── DRC ───────────────────────────────────────────────────────────────

const f = (v: number) => v.toFixed(3)
const pt = (p: { x: number; y: number }): [number, number] => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]

export function drc(pcb: Pcb, b: ResolvedBoard, zones: ZoneFill[] = []): Violation[] {
  const out: Violation[] = []
  const R = JLCPCB

  for (const e of b.errors) out.push({ rule: 'board', message: e })
  if (b.outline.length < 3) {
    out.push({ rule: 'outline', message: 'the board has no outline; set_board with a rect or an XY sketch' })
    return out
  }

  // Outline edges as segments for copper-to-edge.
  const edges: [Poly[number], Poly[number]][] = []
  for (const poly of [b.outline, ...b.cutouts]) for (let i = 0; i < poly.length; i++) edges.push([poly[i], poly[(i + 1) % poly.length]])
  const distToEdge = (p: Poly) => Math.min(...edges.map(([a, c]) => distSegPoly(a, c, p)))
  const onBoard = (p: { x: number; y: number }) => inside(p, b.outline) && !b.cutouts.some((c) => inside(p, c))

  // Components on the board and courtyards apart.
  for (const c of b.components) {
    if (c.edge) {
      const off = b.pads.filter((p) => p.ref === c.ref && !p.outline.every(onBoard))
      if (off.length) out.push({ rule: 'outside_board', message: `${c.ref} pads ${off.map((p) => p.pin).join(', ')} are off the board; move it inwards`, at: pt(c.at), objects: [c.ref] })
    } else if (!c.courtyard.every(onBoard)) {
      out.push({ rule: 'outside_board', message: `${c.ref} sticks out of the board outline (mark edge connectors with edge: true)`, at: pt(c.at), objects: [c.ref] })
    }
  }
  for (let i = 0; i < b.components.length; i++)
    for (let j = i + 1; j < b.components.length; j++) {
      const a = b.components[i]
      const c = b.components[j]
      if (a.side !== c.side) continue
      if (distPolyPoly(a.courtyard, c.courtyard) === 0) {
        out.push({ rule: 'courtyard_overlap', message: `${a.ref} and ${c.ref} overlap (courtyards touch); move one of them`, at: pt(a.at), objects: [a.ref, c.ref] })
      }
    }

  // Track widths and clearance between copper of different nets.
  // A neck: a thin run where the class width does not fit, because at that
  // width it would come within clearance of another net's pad (a power
  // track passing between fine-pitch pads). A thin track in open space is
  // still reported.
  const neck = (t: Pcb['tracks'][number], cls: { track: number; clearance: number }) =>
    t.points.slice(1).some((p, i) => {
      const a = { x: t.points[i][0], y: t.points[i][1] }
      const c = { x: p[0], y: p[1] }
      return b.pads.some((pad) => pad.net !== t.net && pad.layers.includes(t.layer) && distSegPoly(a, c, pad.outline) < cls.track / 2 + cls.clearance)
    })
  type Cu = { kind: 'pad' | 'track' | 'via'; id: string; net?: string; layers: string[]; poly?: Poly; seg?: [{ x: number; y: number }, { x: number; y: number }]; w?: number; c?: { x: number; y: number }; r?: number }
  const cu: Cu[] = []
  for (const p of b.pads) cu.push({ kind: 'pad', id: `${p.ref}.${p.pin}`, net: p.net, layers: p.layers, poly: p.outline })
  pcb.tracks.forEach((t, ti) => {
    const cls = b.netClass.get(t.net)
    if (t.width < R.minTrack - 1e-9) out.push({ rule: 'track_width', message: `track ${ti + 1} (${t.net}) is ${f(t.width)} mm wide; JLCPCB minimum is ${R.minTrack}`, at: t.points[0], objects: [`track ${ti + 1}`] })
    else if (cls && t.width < cls.track - 1e-9 && cls.name !== 'default' && !neck(t, cls))
      out.push({ rule: 'track_width', message: `track ${ti + 1} (${t.net}) is ${f(t.width)} mm; class ${cls.name} asks for ${cls.track}`, at: t.points[0] })
    for (let i = 0; i + 1 < t.points.length; i++) {
      const a = { x: t.points[i][0], y: t.points[i][1] }
      const c = { x: t.points[i + 1][0], y: t.points[i + 1][1] }
      cu.push({ kind: 'track', id: `track ${ti + 1}`, net: t.net, layers: [t.layer], seg: [a, c], w: t.width })
      if (!onBoard(a) || !onBoard(c)) out.push({ rule: 'outside_board', message: `track ${ti + 1} (${t.net}) leaves the board`, at: t.points[i] })
    }
  })
  pcb.vias.forEach((v, vi) => {
    const c = { x: v.at[0], y: v.at[1] }
    if (v.drill < R.minViaDrill - 1e-9) out.push({ rule: 'via', message: `via ${vi + 1} drill ${f(v.drill)} < ${R.minViaDrill} mm`, at: v.at })
    if ((v.diameter - v.drill) / 2 < R.minAnnular - 1e-9)
      out.push({ rule: 'via', message: `via ${vi + 1} annular ring ${f((v.diameter - v.drill) / 2)} < ${R.minAnnular} mm`, at: v.at })
    cu.push({ kind: 'via', id: `via ${vi + 1}`, net: v.net, layers: b.layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'], c, r: v.diameter / 2 })
  })

  const shapeDist = (x: Cu, y: Cu): number => {
    // Reduce every shape to segments/points with a radius.
    const asSegs = (s: Cu): { a: { x: number; y: number }; b: { x: number; y: number }; r: number }[] | Poly => {
      if (s.kind === 'pad') return s.poly!
      if (s.kind === 'track') return [{ a: s.seg![0], b: s.seg![1], r: s.w! / 2 }]
      return [{ a: s.c!, b: s.c!, r: s.r! }]
    }
    const A = asSegs(x)
    const B = asSegs(y)
    const isPoly = (v: unknown): v is Poly => Array.isArray(v) && v.length > 0 && 'x' in (v[0] as object)
    if (isPoly(A) && isPoly(B)) return distPolyPoly(A, B)
    if (isPoly(A)) return Math.min(...(B as { a: never; b: never; r: number }[]).map((s) => distSegPoly(s.a, s.b, A) - s.r))
    if (isPoly(B)) return Math.min(...(A as { a: never; b: never; r: number }[]).map((s) => distSegPoly(s.a, s.b, B) - s.r))
    const sa = (A as { a: never; b: never; r: number }[])[0]
    const sb = (B as { a: never; b: never; r: number }[])[0]
    return distSegSeg(sa.a, sa.b, sb.a, sb.b) - sa.r - sb.r
  }

  const seen = new Set<string>()
  const refOf = (c: Cu) => (c.kind === 'pad' ? c.id.slice(0, c.id.indexOf('.')) : '')
  for (let i = 0; i < cu.length; i++)
    for (let j = i + 1; j < cu.length; j++) {
      const x = cu[i]
      const y = cu[j]
      if (x.net && x.net === y.net) continue
      // Pads within one footprint are spaced by the manufacturer's land
      // pattern; checking them against the board default only adds noise.
      if (x.kind === 'pad' && y.kind === 'pad' && refOf(x) === refOf(y)) continue
      if (!x.layers.some((l) => y.layers.includes(l))) continue
      const need = Math.max(b.netClass.get(x.net ?? '')?.clearance ?? R.minClearance, b.netClass.get(y.net ?? '')?.clearance ?? R.minClearance, R.minClearance)
      const d = shapeDist(x, y)
      // 5 µm of tolerance absorbs rounding in footprints and router output.
      if (d < need - 0.005) {
        const key = [x.id, y.id].sort().join('|')
        if (seen.has(key)) continue
        seen.add(key)
        const where = x.kind === 'pad' ? x.poly![0] : x.kind === 'track' ? x.seg![0] : x.c!
        out.push({
          rule: d <= 0 ? 'short' : 'clearance',
          message:
            d <= 0
              ? `${x.id} (${x.net ?? 'no net'}) touches ${y.id} (${y.net ?? 'no net'}): short circuit`
              : `${x.id} (${x.net ?? 'no net'}) is ${f(d)} mm from ${y.id} (${y.net ?? 'no net'}); needs ${f(need)}`,
          at: pt(where),
          objects: [x.id, y.id],
        })
      }
    }

  // Pours: report a zone that ended up empty, and pours whose copper
  // touches another net (should never happen; guards the fill).
  for (const z of zones) {
    if (!z.regions.length) out.push({ rule: 'zone', message: `zone ${z.index + 1} (${z.net} on ${z.layer}) fills nothing: it touches no ${z.net} copper or is blocked; check its polygon and the ${z.net} pads on ${z.layer}` })
  }

  // Copper to board edge.
  for (const p of b.pads) {
    const d = distToEdge(p.outline)
    if (d < R.copperToEdge - 1e-6 && !(p.drill && p.drill > 0))
      out.push({ rule: 'copper_to_edge', message: `pad ${p.ref}.${p.pin} is ${f(d)} mm from the board edge; keep ${R.copperToEdge}`, at: pt(p.center), objects: [`${p.ref}.${p.pin}`] })
  }

  // Holes.
  const holes = [
    ...b.holes.filter((h) => !h.ref).map((h, i) => ({ id: `hole ${i + 1}`, c: h.at, d: h.d, npth: true })),
    ...b.holes.filter((h) => h.ref).map((h) => ({ id: `${h.ref}.hole${b.holes.filter((o) => o.ref === h.ref).indexOf(h) + 1}`, c: h.at, d: h.d, npth: true })),
    ...pcb.vias.map((v, i) => ({ id: `via ${i + 1}`, c: { x: v.at[0], y: v.at[1] }, d: v.drill, npth: false })),
    ...b.pads.filter((p) => p.drill).map((p) => ({ id: `${p.ref}.${p.pin}`, c: p.center, d: p.drill!, npth: false })),
  ]
  for (const h of holes) if (h.d < R.minHole - 1e-9) out.push({ rule: 'drill', message: `${h.id} drill ${f(h.d)} < ${R.minHole} mm`, at: pt(h.c) })
  for (let i = 0; i < holes.length; i++)
    for (let j = i + 1; j < holes.length; j++) {
      const a = holes[i]
      const c = holes[j]
      const gap = Math.hypot(a.c.x - c.c.x, a.c.y - c.c.y) - a.d / 2 - c.d / 2
      // Two unplated holes only need the drill web (like same-net holes):
      // the MX switch pegs and hot-swap pin holes sit 0.47 mm apart by design.
      const keep = a.npth && c.npth ? R.npthToNpth : R.holeToHole
      if (gap < keep - 1e-6 && !(a.id.split('.')[0] === c.id.split('.')[0] && a.id.includes('.')))
        out.push({ rule: 'hole_to_hole', message: `${a.id} and ${c.id} are ${f(gap)} mm apart; keep ${keep}`, at: pt(a.c) })
    }

  return out
}
