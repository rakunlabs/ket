// Routed lengths, differential pairs and length matching: what the
// get_net_lengths query reports and what DRC checks.

import { type Pcb, copperLayersOf, viaLayers } from '../doc'
import type { ResolvedBoard } from './board'
import type { Violation } from './drc'

export interface NetLength {
  net: string
  /** Track length, mm. */
  tracks: number
  vias: number
  /** Tracks plus the via barrels (each via counts the board depth it spans). */
  length: number
  /** More than two track ends: a branched net, its total copper is not one path. */
  branched: boolean
}

const r3 = (v: number) => Math.round(v * 1000) / 1000

/** Depth through the board between two copper layers, mm (from the stackup, else spread evenly). */
function depth(pcb: Pcb, b: ResolvedBoard, from: number, to: number): number {
  if (pcb.stackup) {
    let d = 0
    for (let i = Math.min(from, to); i < Math.max(from, to); i++) d += pcb.stackup.dielectric[i].thickness + pcb.stackup.copper[i + 1] / 1000
    return d
  }
  return (b.thickness * Math.abs(to - from)) / Math.max(1, b.layers - 1)
}

export function netLengths(pcb: Pcb, b: ResolvedBoard, nets?: string[]): NetLength[] {
  const all = copperLayersOf(b.layers)
  const want = nets ?? pcb.nets.map((n) => n.name)
  return want.map((net) => {
    const tracks = pcb.tracks.filter((t) => t.net === net)
    let len = 0
    for (const t of tracks) for (let i = 1; i < t.points.length; i++) len += Math.hypot(t.points[i][0] - t.points[i - 1][0], t.points[i][1] - t.points[i - 1][1])
    const vias = pcb.vias.filter((v) => v.net === net)
    // A signal through a via travels between the layers its tracks are on there.
    let barrel = 0
    for (const v of vias) {
      const here = tracks.filter((t) => t.points.some((p) => Math.hypot(p[0] - v.at[0], p[1] - v.at[1]) <= v.diameter / 2 + 1e-3)).map((t) => all.indexOf(t.layer))
      const span = viaLayers(v, b.layers).map((l) => all.indexOf(l))
      const [lo, hi] = here.length >= 2 ? [Math.min(...here), Math.max(...here)] : [span[0], span[span.length - 1]]
      barrel += depth(pcb, b, lo, hi)
    }
    // Ends: track end points not shared with another track of the net (rounded to 1 µm).
    const key = (p: [number, number]) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`
    const ends = new Map<string, number>()
    for (const t of tracks) for (const p of [t.points[0], t.points[t.points.length - 1]]) ends.set(key(p), (ends.get(key(p)) ?? 0) + 1)
    const loose = [...ends.values()].filter((c) => c === 1).length
    return { net, tracks: r3(len), vias: vias.length, length: r3(len + barrel), branched: loose > 2 }
  })
}

/** Gap along a pair: where the two nets run side by side on one layer, the smallest and largest edge gap seen, mm. */
function pairGap(pcb: Pcb, p: string, n: string, target: number): { min: number; max: number; coupled: number } | undefined {
  const seg = (net: string) =>
    pcb.tracks.filter((t) => t.net === net).flatMap((t) => t.points.slice(1).map((q, i) => ({ a: t.points[i], b: q, w: t.width, layer: t.layer })))
  const P = seg(p)
  const N = seg(n)
  let min = Infinity
  let max = 0
  let coupled = 0
  for (const s of P) {
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1])
    if (L < 1e-6) continue
    const u = [(s.b[0] - s.a[0]) / L, (s.b[1] - s.a[1]) / L]
    for (const o of N) {
      if (o.layer !== s.layer) continue
      const M = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1])
      if (M < 1e-6) continue
      const v = [(o.b[0] - o.a[0]) / M, (o.b[1] - o.a[1]) / M]
      // Parallel within 1°.
      if (Math.abs(u[0] * v[1] - u[1] * v[0]) > 0.0175) continue
      // Perpendicular distance and the overlap of their projections.
      const dist = Math.abs((o.a[0] - s.a[0]) * -u[1] + (o.a[1] - s.a[1]) * u[0])
      const t0 = (o.a[0] - s.a[0]) * u[0] + (o.a[1] - s.a[1]) * u[1]
      const t1 = (o.b[0] - s.a[0]) * u[0] + (o.b[1] - s.a[1]) * u[1]
      const overlap = Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1))
      if (overlap <= 0.05) continue
      const gap = dist - (s.w + o.w) / 2
      // Only the coupled run counts: a parallel piece clearly apart (more than twice
      // the pair gap: a pad escape, a tuning meander's far leg) is where the pair
      // splits, not a wrong gap.
      if (gap > Math.max(2 * target, target + 0.2)) continue
      min = Math.min(min, gap)
      max = Math.max(max, gap)
      coupled += overlap
    }
  }
  return Number.isFinite(min) ? { min, max, coupled } : undefined
}

export interface PairReport {
  name: string
  p: NetLength
  n: NetLength
  skew: number
  gap?: { min: number; max: number }
  /** Share of the shorter net's track length that runs coupled at the gap. */
  coupled: number
}

export function pairReports(pcb: Pcb, b: ResolvedBoard): PairReport[] {
  return (pcb.diff_pairs ?? []).map((d) => {
    const [p, n] = netLengths(pcb, b, [d.p, d.n])
    const g = pairGap(pcb, d.p, d.n, d.gap)
    const shorter = Math.min(p.tracks, n.tracks)
    return { name: d.name, p, n, skew: r3(Math.abs(p.length - n.length)), ...(g ? { gap: { min: r3(g.min), max: r3(g.max) } } : {}), coupled: shorter > 0 ? r3(Math.min(1, (g?.coupled ?? 0) / shorter)) : 0 }
  })
}

/** DRC for pairs (gap, width, skew) and length groups. Unrouted nets are left to the ratsnest. */
export function lengthViolations(pcb: Pcb, b: ResolvedBoard): Violation[] {
  const out: Violation[] = []
  const f = (v: number) => v.toFixed(3)
  for (const d of pcb.diff_pairs ?? []) {
    const r = pairReports({ ...pcb, diff_pairs: [d] }, b)[0]
    if (!r.p.tracks || !r.n.tracks) continue
    const skew = d.skew ?? 0.15
    if (r.skew > skew + 1e-6)
      out.push({ rule: 'diff_skew', message: `pair ${d.name}: ${d.p} is ${f(r.p.length)} mm and ${d.n} ${f(r.n.length)} mm, ${f(r.skew)} mm apart; keep within ${skew} (lengthen the shorter one)`, objects: [d.p, d.n], measured: r.skew, required: skew, fix: 'Lengthen the shorter net (a small serpentine near the mismatch) or reroute the pair together.' })
    if (r.gap && (r.gap.min < d.gap - 0.01 || r.gap.max > d.gap + 0.01))
      out.push({ rule: 'diff_gap', message: `pair ${d.name}: the gap between ${d.p} and ${d.n} runs ${f(r.gap.min)}..${f(r.gap.max)} mm where they are side by side; it should be ${d.gap}`, objects: [d.p, d.n], measured: r.gap.min, required: d.gap, fix: 'Route the two tracks together at the pair gap.' })
    if (r.coupled < 0.7)
      out.push({ rule: 'diff_coupling', message: `pair ${d.name}: only ${Math.round(r.coupled * 100)}% of ${d.p}/${d.n} runs side by side; route them together (they split for more than a short pad escape)`, objects: [d.p, d.n], measured: r.coupled })
    for (const net of [d.p, d.n])
      for (const [ti, t] of pcb.tracks.entries())
        if (t.net === net && Math.abs(t.width - d.width) > 0.005) {
          out.push({ rule: 'diff_width', message: `track ${ti + 1} (${net}) is ${f(t.width)} mm; pair ${d.name} needs ${d.width}`, objects: [`track ${ti + 1}`], measured: t.width, required: d.width })
          break
        }
  }
  for (const g of pcb.length_groups ?? []) {
    const ls = netLengths(pcb, b, g.nets).filter((l) => l.tracks > 0)
    if (ls.length < 1) continue
    const longest = Math.max(...ls.map((l) => l.length))
    for (const l of ls) {
      if (longest - l.length > g.tolerance + 1e-6) out.push({ rule: 'length_match', message: `group ${g.name}: ${l.net} is ${f(l.length)} mm, ${f(longest - l.length)} mm shorter than the longest (${f(longest)}); keep within ${g.tolerance}`, objects: [l.net], measured: longest - l.length, required: g.tolerance })
      if (g.max !== undefined && l.length > g.max + 1e-6) out.push({ rule: 'length_max', message: `group ${g.name}: ${l.net} is ${f(l.length)} mm, over ${g.max}`, objects: [l.net], measured: l.length, required: g.max })
      if (g.min !== undefined && l.length < g.min - 1e-6) out.push({ rule: 'length_min', message: `group ${g.name}: ${l.net} is ${f(l.length)} mm, under ${g.min}`, objects: [l.net], measured: l.length, required: g.min })
      if (l.branched) out.push({ rule: 'length_match', message: `group ${g.name}: ${l.net} branches, so its length is the total copper, not one path; match nets that run point to point`, objects: [l.net] })
    }
  }
  return out
}
