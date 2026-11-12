// Coupled routing of differential pairs: the positive net is routed by the
// grid router, the negative one follows it at width + gap (an offset of the
// same path), joined to its pads by short escapes. Every piece is checked
// with the exact clearance test; when the offset does not fit on either
// side the pair falls back to two independent routes and says so.

import type { DiffPair, Pcb, Track, Via } from '../doc'
import { clearance } from './autoroute'
import type { ResolvedBoard } from './board'
import { netLengths } from './lengths'
import { routeBoard } from './router'
import { tuneLength } from './tune'

type XY = [number, number]

export interface PairRoute {
  pair: string
  tracks: Track[]
  vias: Via[]
  coupled: boolean
  note?: string
}

const r3 = (v: number) => Math.round(v * 1000) / 1000

/** Joins a net's track pieces on one layer into one polyline from `from` (pieces share end points). */
function chain(tracks: Track[], from: XY): XY[] | undefined {
  const left = tracks.map((t) => [...t.points] as XY[])
  const near = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3
  // Start at the piece whose end is nearest to `from`.
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

/** The polyline offset by d to its left (miter joins). */
function offsetPath(path: XY[], d: number): XY[] {
  const n = (a: XY, b: XY): XY => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]
  }
  return path.map((p, i) => {
    const n0 = i > 0 ? n(path[i - 1], p) : n(p, path[i + 1])
    const n1 = i < path.length - 1 ? n(p, path[i + 1]) : n0
    const m: XY = [n0[0] + n1[0], n0[1] + n1[1]]
    const ml = Math.hypot(m[0], m[1]) || 1
    const cos = (m[0] * n0[0] + m[1] * n0[1]) / ml
    const k = d / Math.max(0.3, cos)
    return [r3(p[0] + (m[0] / ml) * k), r3(p[1] + (m[1] / ml) * k)]
  })
}

/** Routes one pair. pcb holds the copper routed so far (obstacles). */
export function routePair(pcb: Pcb, b: ResolvedBoard, d: DiffPair, budget: number): PairRoute {
  const r = routeBoard(pcb, b, { only: new Set([d.p]), budget })
  const pTracks = r.tracks.filter((t) => t.net === d.p)
  const padsP = b.pads.filter((p) => p.net === d.p)
  const padsN = b.pads.filter((p) => p.net === d.n)
  const fallback = (why: string): PairRoute => {
    const both = routeBoard(pcb, b, { only: new Set([d.p, d.n]), budget })
    return { pair: d.name, tracks: both.tracks, vias: both.vias, coupled: false, note: `${d.name} routed as two separate nets: ${why}` }
  }
  if (r.unrouted.length || !pTracks.length) return fallback(`${d.p} found no route`)
  if (r.vias.length || new Set(pTracks.map((t) => t.layer)).size > 1) return fallback(`${d.p} changes layer; coupled routing follows one layer`)
  if (padsP.length !== 2 || padsN.length !== 2) return fallback('coupled routing joins two pads per net (point to point)')
  const start: XY = [padsP[0].center.x, padsP[0].center.y]
  const path = chain(pTracks, start)
  if (!path || path.length < 2) return fallback(`${d.p}'s route is not one path`)
  const layer = pTracks[0].layer
  const pitch = d.width + d.gap
  const ok = clearance(b, [...pcb.tracks, ...pTracks], pcb.vias)
  for (const side of [1, -1]) {
    const off = offsetPath(path, side * pitch)
    // Each N pad joins the end of the offset path near its P partner pad.
    const nearest = (q: XY) => padsN.slice().sort((x, y) => Math.hypot(x.center.x - q[0], x.center.y - q[1]) - Math.hypot(y.center.x - q[0], y.center.y - q[1]))[0]
    const nA = nearest(off[0])
    const nB = nearest(off[off.length - 1])
    if (nA === nB) continue
    // The coupled run: the offset path, its ends pulled in along the path until
    // it keeps clearance (near the pads the pair splits to reach them).
    const fits = (a: XY, c: XY) => ok(d.n, layer, d.width, a, c)
    const trim = (pts: XY[]): XY[] | undefined => {
      // Walk from the start in 0.1 mm steps until the first piece fits.
      let p0 = [...pts]
      for (let guard = 0; guard < 400 && p0.length >= 2; guard++) {
        if (fits(p0[0], p0[1])) return p0
        const [a, c] = [p0[0], p0[1]]
        const l = Math.hypot(c[0] - a[0], c[1] - a[1])
        if (l <= 0.1) p0 = p0.slice(1)
        else p0 = [[a[0] + ((c[0] - a[0]) / l) * 0.1, a[1] + ((c[1] - a[1]) / l) * 0.1], ...p0.slice(1)]
      }
      return undefined
    }
    const front = trim(off)
    const back = front && trim([...front].reverse())
    if (!back || back.length < 2) continue
    const core = back.reverse().map((q) => [r3(q[0]), r3(q[1])] as XY)
    if (!core.slice(1).every((q, k) => fits(core[k], q))) continue
    // Join each end of the run to its N pad: straight, or an octilinear dog-leg (45° then straight), whichever keeps clearance.
    const pTrack: Track = { net: d.p, layer, width: d.width, points: path.map((q) => [r3(q[0]), r3(q[1])]) }
    const ok2 = clearance(b, [...pcb.tracks, pTrack], pcb.vias)
    const fits2 = (a: XY, c: XY) => ok2(d.n, layer, d.width, a, c)
    const escape = (pad: XY, end: XY): XY[] | undefined => {
      if (fits2(pad, end)) return [pad, end]
      const dx = end[0] - pad[0]
      const dy = end[1] - pad[1]
      const m = Math.min(Math.abs(dx), Math.abs(dy))
      for (const knee of [
        [pad[0] + Math.sign(dx) * m, pad[1] + Math.sign(dy) * m],
        [end[0] - Math.sign(dx) * m, end[1] - Math.sign(dy) * m],
        [end[0], pad[1]],
        [pad[0], end[1]],
      ] as XY[])
        if (fits2(pad, knee) && fits2(knee, end)) return [pad, knee, end]
      return undefined
    }
    const [first, last] = [core[0], core[core.length - 1]]
    const padNear = (q: XY) => padsN.slice().sort((x, y) => Math.hypot(x.center.x - q[0], x.center.y - q[1]) - Math.hypot(y.center.x - q[0], y.center.y - q[1]))[0]
    const pa = padNear(first)
    const pb = padNear(last)
    if (pa === pb) continue
    const ea = escape([pa.center.x, pa.center.y], first)
    const eb = escape([pb.center.x, pb.center.y], last)
    if (!ea || !eb) continue
    const n: XY[] = [...ea.slice(0, -1), ...core, ...eb.slice(0, -1).reverse()]
    const clean = n.filter((q, i) => i === 0 || Math.hypot(q[0] - n[i - 1][0], q[1] - n[i - 1][1]) > 1e-6).map((q) => [r3(q[0]), r3(q[1])] as XY)
    void nA
    void nB
    const nTrack: Track = { net: d.n, layer, width: d.width, points: clean }
    // Match the lengths: a meander on the shorter net (outside the pair, away from its partner).
    const tracks = [pTrack, nTrack]
    const skew = d.skew ?? 0.15
    const ls = netLengths({ ...pcb, tracks: [...pcb.tracks, ...tracks] }, b, [d.p, d.n])
    if (Math.abs(ls[0].length - ls[1].length) > skew) {
      const shorter = ls[0].length < ls[1].length ? d.p : d.n
      try {
        const tuned = tuneLength({ ...pcb, tracks: [...pcb.tracks, ...tracks] }, b, shorter, Math.max(ls[0].length, ls[1].length), { amplitude: Math.max(3 * d.width, d.gap * 2 + d.width), spacing: 3 * d.width, away: shorter === d.p ? d.n : d.p })
        const mine = tuned.tracks.filter((x) => x.net === d.p || x.net === d.n)
        const after = netLengths({ ...pcb, tracks: tuned.tracks }, b, [d.p, d.n])
        if (Math.abs(after[0].length - after[1].length) <= skew + 1e-6) return { pair: d.name, tracks: mine, vias: [], coupled: true }
        return { pair: d.name, tracks: mine, vias: [], coupled: true, note: `${d.name}: skew ${Math.abs(after[0].length - after[1].length).toFixed(3)} mm after tuning; tune_length ${shorter} on a longer straight run` }
      } catch (e) {
        return { pair: d.name, tracks, vias: [], coupled: true, note: `${d.name} is routed together but ${Math.abs(ls[0].length - ls[1].length).toFixed(3)} mm apart in length: ${(e as Error).message}` }
      }
    }
    return { pair: d.name, tracks, vias: [], coupled: true }
  }
  return fallback(`no room beside ${d.p}'s route for ${d.n} at ${pitch} mm on either side`)
}
