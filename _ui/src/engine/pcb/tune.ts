// Length tuning: a serpentine (accordion) put into the longest straight
// segment of a net's track until the net reaches a target length, keeping
// clearance to everything else (exact checks as the autorouter's clean-up).

import type { Pcb, Track } from '../doc'
import { clearance } from './autoroute'
import type { ResolvedBoard } from './board'
import { netLengths } from './lengths'

type XY = [number, number]

export interface TuneOptions {
  /** Meander amplitude (height of each bump from the track's line), mm. */
  amplitude: number
  /** Distance between the legs of the meander, mm (≥ 3 × track width is usual). */
  spacing: number
  /** Which side of the track the bumps go: 1 left, -1 right, 0 alternating both. */
  side?: 1 | -1 | 0
  /** A partner net (the other half of a pair): bumps go on the side away from it. */
  away?: string
}

export interface TuneResult {
  tracks: Track[]
  added: number
  before: number
  after: number
  note?: string
}

/**
 * Adds length to net up to `target` mm by replacing part of its longest
 * straight segment with a meander. Each bump adds 2 × amplitude; bumps are
 * placed from the segment's middle outwards while there is room and
 * clearance. Returns the net's new tracks (the others untouched).
 */
export function tuneLength(pcb: Pcb, b: ResolvedBoard, net: string, target: number, o: TuneOptions): TuneResult {
  const [cur] = netLengths(pcb, b, [net])
  const before = cur.length
  const need = target - before
  if (need <= 1e-6) return { tracks: pcb.tracks, added: 0, before, after: before, note: `${net} is ${before.toFixed(3)} mm, already at or over ${target}` }
  if (!(o.amplitude > 0 && o.spacing > 0)) throw new Error('amplitude and spacing must be > 0')
  const w = Math.max(...pcb.tracks.filter((x) => x.net === net).map((x) => x.width), 0)
  // Legs closer than a track width plus clearance merge into one blob of copper and couple to each other.
  if (o.spacing < w + 0.15) throw new Error(`spacing ${o.spacing} mm is too tight for ${w} mm tracks: the legs would touch; use at least ${(w + 0.15).toFixed(2)} (3 × width is usual)`)
  // Segments of the net, longest first.
  const segs: { ti: number; si: number; len: number }[] = []
  pcb.tracks.forEach((t, ti) => {
    if (t.net !== net) return
    for (let si = 1; si < t.points.length; si++) segs.push({ ti, si, len: Math.hypot(t.points[si][0] - t.points[si - 1][0], t.points[si][1] - t.points[si - 1][1]) })
  })
  if (!segs.length) throw new Error(`${net} has no tracks: route it first`)
  segs.sort((x, y) => y.len - x.len)
  const others = pcb.tracks.filter((t) => t.net !== net)
  const ok = clearance(b, others, pcb.vias)
  // Without a side: try left, then right, of each run.
  const sides: (1 | -1 | 0)[] = o.side === undefined ? [1, -1] : [o.side]
  for (const s of segs.flatMap((x) => sides.map((side) => ({ ...x, side })))) {
    const t = pcb.tracks[s.ti]
    const [a, c] = [t.points[s.si - 1], t.points[s.si]]
    const u: XY = [(c[0] - a[0]) / s.len, (c[1] - a[1]) / s.len]
    const nrm: XY = [-u[1], u[0]]
    // Away from the partner: the side whose normal points from the partner's nearest copper.
    let awaySide: 1 | -1 | undefined
    if (o.away) {
      const mid: XY = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]
      let best = Infinity
      for (const x of pcb.tracks) {
        if (x.net !== o.away) continue
        for (const q of x.points) {
          const dd = Math.hypot(q[0] - mid[0], q[1] - mid[1])
          if (dd < best) {
            best = dd
            awaySide = (q[0] - mid[0]) * nrm[0] + (q[1] - mid[1]) * nrm[1] > 0 ? -1 : 1
          }
        }
      }
    }
    if (awaySide !== undefined && s.side !== awaySide) continue
    // Leave one spacing plus the width free at each end (corners and pads).
    const margin = o.spacing + t.width
    const room = s.len - 2 * margin
    if (room < o.spacing * 2) continue
    // Each bump: up amplitude, across spacing, down amplitude, across spacing. It adds 2 × amplitude.
    const bumpsWanted = Math.ceil(need / (2 * o.amplitude) - 1e-9)
    const bumpsFit = Math.floor(room / (2 * o.spacing))
    const bumps = Math.min(bumpsWanted, bumpsFit)
    if (bumps < 1) continue
    // The last bump may be lower to land on the target exactly.
    const fullBumps = Math.min(bumps, Math.floor(need / (2 * o.amplitude) + 1e-9))
    const rest = need - fullBumps * 2 * o.amplitude
    const used = bumps * 2 * o.spacing
    const start = (s.len - used) / 2
    const pts: XY[] = [a]
    const at = (d: number, h: number): XY => [a[0] + u[0] * d + nrm[0] * h, a[1] + u[1] * d + nrm[1] * h]
    let d = start
    pts.push(at(d, 0))
    for (let k = 0; k < bumps; k++) {
      const side = s.side === 0 ? (k % 2 ? -1 : 1) : s.side
      const amp = k < fullBumps ? o.amplitude : rest / 2
      if (amp < 1e-6) break
      pts.push(at(d, side * amp), at(d + o.spacing, side * amp), at(d + o.spacing, 0))
      d += 2 * o.spacing
      pts.push(at(d, 0))
    }
    pts.push(c)
    // Drop repeated points.
    const clean = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-6)
    // The lead-in and lead-out lie on the old segment (already where it was); check the meander itself.
    const fits = clean.slice(1).every((p, i) => {
      const q = clean[i]
      const onLine = Math.abs((q[0] - a[0]) * nrm[0] + (q[1] - a[1]) * nrm[1]) < 1e-6 && Math.abs((p[0] - a[0]) * nrm[0] + (p[1] - a[1]) * nrm[1]) < 1e-6
      return onLine || ok(net, t.layer, t.width, q, p, t)
    })
    if (!fits) continue
    const nt: Track = { ...t, points: [...t.points.slice(0, s.si - 1), ...clean.map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000] as XY), ...t.points.slice(s.si + 1)] }
    const tracks = pcb.tracks.map((x, i) => (i === s.ti ? nt : x))
    const [now] = netLengths({ ...pcb, tracks }, b, [net])
    const short = target - now.length
    return {
      tracks,
      added: Math.round((now.length - before) * 1000) / 1000,
      before,
      after: now.length,
      ...(short > 0.01 ? { note: `${short.toFixed(3)} mm short of ${target}: the longest straight run has room for ${bumps} bump(s); use a larger amplitude or tune another segment` } : {}),
    }
  }
  throw new Error(`no straight run of ${net} has room for a meander with amplitude ${o.amplitude} and spacing ${o.spacing} that keeps clearance; try a smaller amplitude, side -1, or move neighbours`)
}
