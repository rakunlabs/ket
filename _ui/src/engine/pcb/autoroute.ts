// Autorouting: Ket's own grid router (router.ts) lays the copper, then
// every track is cleaned up to 0/45/90° against the exact geometry
// (octilinear.ts), widened to its class width where it fits, and checked
// with Ket's DRC. Runs in the kernel worker, in the browser and in Node.

import { type LayerCount, type Pcb, type Track, type Via, viaLayers } from '../doc'
import type { ResolvedBoard } from './board'
import { DEFAULT_CLASS } from './board'
import type { Violation } from './drc'
import { octilinear } from './octilinear'
import { routeBoard } from './router'
import { routePair } from './pairroute'
import { type XY, distPS, distSS, distSegEdges, insidePoly } from './geom2d'

/** Whether a via has copper on a layer: blind and buried ones only on their span. */
const onVia = (v: Via, layer: string, layers: LayerCount) => !v.span || viaLayers(v, layers).includes(layer as never)

/**
 * Brings tracks to their net class width, segment by segment, as wide as
 * fits (class width, then down in 0.05 mm steps) with clearance to every
 * pad, via, hole and other net's track. A segment that cannot get wider
 * stays as it is (a neck between fine-pitch pads).
 */
export function widenTracks(tracks: Track[], b: ResolvedBoard, existing: Track[] = [], vias: Via[] = []): Track[] {
  const def = b.classes.get('default') ?? DEFAULT_CLASS
  type Seg = { a: [number, number]; b: [number, number]; w: number; layer: string; net: string }
  const segs: Seg[] = [...existing, ...tracks].flatMap((t) => t.points.slice(1).map((p, i) => ({ a: t.points[i], b: p, w: t.width, layer: t.layer, net: t.net })))
  // Board edge and keep-outs: widening must not push copper into either.
  const edges: [[number, number], [number, number]][] = []
  for (const poly of [b.outline, ...b.cutouts]) for (let i = 0; i < poly.length; i++) edges.push([[poly[i].x, poly[i].y], [poly[(i + 1) % poly.length].x, poly[(i + 1) % poly.length].y]])
  const edgeGap = Math.max(0.3, def.clearance)
  const padDist = (s: Seg, pad: ResolvedBoard['pads'][number]) => {
    return distSegEdges(s.a, s.b, pad.outline)
  }
  const out: Track[] = []
  for (const t of tracks) {
    const cls = b.netClass.get(t.net) ?? def
    if (t.width >= cls.track - 1e-9) {
      out.push(t)
      continue
    }
    // This track's own segments in segs (they get the new width as it is decided).
    const mine = segs.filter((sg) => sg.net === t.net && sg.layer === t.layer && t.points.some((p) => p === sg.a))
    // Widths to try, widest first: the class width, then down in 0.05 mm steps
    // (never under the default class width or the track's own).
    const floor = Math.max(t.width, Math.min(cls.track, def.track))
    const ladder: number[] = [cls.track]
    for (let w = Math.floor((cls.track - 1e-9) / 0.05) * 0.05; w > floor + 1e-9; w -= 0.05) ladder.push(Math.round(w * 1000) / 1000)
    const fitsAt = (s: Seg, w: number): boolean => {
      for (const pad of b.pads) {
        if (pad.net === t.net || !pad.layers.includes(t.layer)) continue
        if (padDist(s, pad) < w / 2 + cls.clearance) return false
      }
      for (const v of vias) if (v.net !== t.net && onVia(v, t.layer, b.layers) && distPS(v.at, s.a, s.b) < w / 2 + v.diameter / 2 + cls.clearance) return false
      for (const h of b.holes) if (distPS([h.at.x, h.at.y], s.a, s.b) < w / 2 + h.d / 2 + cls.clearance) return false
      for (const [e0, e1] of edges) if (distSS(s.a, s.b, e0, e1) < w / 2 + edgeGap - 1e-6) return false
      for (const k of b.keepouts ?? []) {
        if (!k.forbid.has('tracks') || !k.layers.includes(t.layer)) continue
        if (distSegEdges(s.a, s.b, k.polygon) < w / 2 + cls.clearance - 1e-6) return false
      }
      for (const o of segs) {
        if (o.net === t.net || o.layer !== t.layer) continue
        const c = Math.max(cls.clearance, (b.netClass.get(o.net) ?? def).clearance)
        if (distSS(s.a, s.b, o.a, o.b) < w / 2 + o.w / 2 + c) return false
      }
      return true
    }
    // The width each segment gets.
    const widths = t.points.slice(1).map((p, i) => {
      const s: Seg = { a: t.points[i], b: p, w: 0, layer: t.layer, net: t.net }
      const w = ladder.find((x) => fitsAt(s, x)) ?? floor
      const own = mine.find((sg) => sg.a === t.points[i])
      if (own) own.w = w
      return w
    })
    let start = 0
    for (let i = 1; i <= widths.length; i++) {
      if (i < widths.length && Math.abs(widths[i] - widths[start]) < 1e-9) continue
      out.push({ ...t, width: widths[start], points: t.points.slice(start, i + 1) })
      start = i
    }
  }
  return out
}

/** Routes the board (only: just these nets; skip: nets left to pours). */
export async function autorouteBoard(
  pcb: Pcb,
  b: ResolvedBoard,
  opts: { skip?: Set<string>; only?: Set<string>; timeout?: number; check?: (r: { tracks: Track[]; vias: Via[] }) => Violation[] } = {},
): Promise<{ tracks: Track[]; vias: Via[]; nets: number; seconds: number; unrouted: string[]; rounds: number; violations: string[] }> {
  const started = Date.now()
  const nets = pcb.nets.filter((n) => n.pins.length >= 2 && !opts.skip?.has(n.name) && (!opts.only || opts.only.has(n.name))).length
  if (!nets) throw new Error(opts.only ? `nothing to route among ${[...opts.only].join(', ')}: they need 2+ pins and must not be left to a pour` : 'nothing to route: every net with 2+ pins is routed or left to a pour')
  const budget = (opts.timeout ?? 180) * 1000
  // Differential pairs first, coupled (one follows the other at the pair pitch); the rest route around them.
  const pairs = (pcb.diff_pairs ?? []).filter((d) => !opts.skip?.has(d.p) && !opts.skip?.has(d.n) && (!opts.only || (opts.only.has(d.p) && opts.only.has(d.n))) && !pcb.tracks.some((t) => t.net === d.p || t.net === d.n))
  const pairTracks: Track[] = []
  const pairVias: Via[] = []
  const notes: string[] = []
  for (const d of pairs) {
    const pr = routePair({ ...pcb, tracks: [...pcb.tracks, ...pairTracks], vias: [...pcb.vias, ...pairVias] }, b, d, budget / 4)
    pairTracks.push(...pr.tracks)
    pairVias.push(...pr.vias)
    if (pr.note) notes.push(pr.note)
  }
  const paired = new Set(pairs.flatMap((d) => [d.p, d.n]))
  const rest = pcb.nets.some((n) => n.pins.length >= 2 && !paired.has(n.name) && !opts.skip?.has(n.name) && (!opts.only || opts.only.has(n.name)))
  const base = { ...pcb, tracks: [...pcb.tracks, ...pairTracks], vias: [...pcb.vias, ...pairVias] }
  const r = rest ? routeBoard(base, b, { only: opts.only, skip: new Set([...(opts.skip ?? []), ...paired]), budget }) : { tracks: [], vias: [], unrouted: [], iterations: 0 }
  // Pair tracks keep their exact geometry (the clean-up would move them apart); the rest is tidied around them.
  const tracks = [...pairTracks, ...widenTracks(tidyRouted(r.tracks, r.vias, base, b), b, base.tracks, [...base.vias, ...r.vias])]
  const out = { tracks, vias: [...pairVias, ...r.vias] }
  const violations = opts.check ? opts.check(out) : []
  const unrouted = [...r.unrouted, ...pairs.flatMap((d) => [d.p, d.n]).filter((n) => !pairTracks.some((t) => t.net === n))]
  return { ...out, nets, unrouted, seconds: Math.round((Date.now() - started) / 100) / 10, rounds: r.iterations, violations: [...notes, ...violations.map((v) => v.message)].slice(0, 10) }
}

/** Cleans existing tracks: octilinear and as wide as fits, against all other copper. */
export function tidyTracks(tracks: Track[], others: Track[], vias: Via[], pcb: Pcb, b: ResolvedBoard): Track[] {
  const tidy = tidyRouted(tracks, [], { ...pcb, tracks: others, vias }, b)
  return widenTracks(tidy, b, others, vias)
}

/**
 * Exact clearance test for a straight piece of a track of net/width on a
 * layer against everything else: pads, holes, vias, other tracks, edge.
 */
export function clearance(b: ResolvedBoard, others: Track[], vias: Via[]) {
  const def = b.classes.get('default') ?? DEFAULT_CLASS
  const edges: [XY, XY][] = []
  for (const poly of [b.outline, ...b.cutouts]) for (let i = 0; i < poly.length; i++) edges.push([[poly[i].x, poly[i].y], [poly[(i + 1) % poly.length].x, poly[(i + 1) % poly.length].y]])
  const edgeGap = Math.max(0.3, def.clearance)
  const onBoard = (p: XY) => insidePoly(p, b.outline) && !b.cutouts.some((c) => insidePoly(p, c))
  return (net: string, layer: string, width: number, a: XY, c: XY, skipTrack?: Track): boolean => {
    const cls = b.netClass.get(net) ?? def
    const half = width / 2
    if (!onBoard(a) || !onBoard(c)) return false
    for (const [e0, e1] of edges) if (distSS(a, c, e0, e1) < half + edgeGap - 1e-6) return false
    for (const p of b.pads) {
      if (p.net === net || !p.layers.includes(layer)) continue
      const o = p.outline
      if (insidePoly(a, o) || insidePoly(c, o)) return false
      if (distSegEdges(a, c, o) < half + cls.clearance - 1e-6) return false
    }
    for (const p of b.pads) if (p.drill && p.net !== net && distPS([p.center.x, p.center.y], a, c) < half + p.drill / 2 + cls.clearance) return false
    for (const v of vias) if (v.net !== net && onVia(v, layer, b.layers) && distPS(v.at, a, c) < half + v.diameter / 2 + cls.clearance - 1e-6) return false
    for (const h of b.holes) if (distPS([h.at.x, h.at.y], a, c) < half + h.d / 2 + cls.clearance) return false
    // Keep-outs that forbid tracks on this layer: the segment must stay clear of them.
    for (const k of b.keepouts ?? []) {
      if (!k.forbid.has('tracks') || !k.layers.includes(layer)) continue
      const o = k.polygon
      if (insidePoly(a, o) || insidePoly(c, o)) return false
      if (distSegEdges(a, c, o) < half + cls.clearance - 1e-6) return false
    }
    for (const o of others) {
      if (o === skipTrack || o.net === net || o.layer !== layer) continue
      const cc = Math.max(cls.clearance, (b.netClass.get(o.net) ?? def).clearance)
      for (let i = 1; i < o.points.length; i++) if (distSS(a, c, o.points[i - 1], o.points[i]) < half + o.width / 2 + cc - 1e-6) return false
    }
    return true
  }
}

/** Octilinear clean-up of freshly routed tracks, each against all other copper. */
function tidyRouted(tracks: Track[], vias: Via[], pcb: Pcb, b: ResolvedBoard): Track[] {
  const out = tracks.map((t) => ({ ...t, points: [...t.points] }))
  const allVias = [...pcb.vias, ...vias]
  // A branch ends somewhere along another track of its net: put that point
  // into the other track, so the clean-up keeps the joint there.
  for (const t of out)
    for (const e of [t.points[0], t.points[t.points.length - 1]])
      for (const o of out) {
        if (o === t || o.net !== t.net || o.layer !== t.layer) continue
        for (let i = 1; i < o.points.length; i++) {
          const a = o.points[i - 1]
          const c = o.points[i]
          if (Math.hypot(e[0] - a[0], e[1] - a[1]) < 0.01 || Math.hypot(e[0] - c[0], e[1] - c[1]) < 0.01) break
          if (distPS(e, a, c) < 0.01) {
            o.points.splice(i, 0, e)
            break
          }
        }
      }
  for (let pass = 0; pass < 2; pass++) {
    for (const t of out) {
      const clear = clearance(b, [...pcb.tracks, ...out], allVias)
      // Points where other copper of the net joins stay.
      const keep = (p: XY) =>
        allVias.some((v) => v.net === t.net && Math.hypot(v.at[0] - p[0], v.at[1] - p[1]) < 0.01) ||
        [...pcb.tracks, ...out].some((o) => o !== t && o.net === t.net && o.layer === t.layer && o.points.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.01))
      t.points = octilinear(t.points, (a, c) => clear(t.net, t.layer, t.width, a, c, t), keep)
    }
  }
  return out
}
