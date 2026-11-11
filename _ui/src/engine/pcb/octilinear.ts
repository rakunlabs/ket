// Octilinear clean-up of routed tracks, after KiCad's PNS optimizer (the
// idea, not its code): replace runs of a path by a two-leg 0/45/90° bridge
// (one straight leg and one diagonal leg, either order) when the bridge is
// clear of other copper and lowers the corner cost; merge collinear points;
// chamfer the right angles that are left with the largest 45° cut that fits.
// Corner costs follow KiCad: straight 0, 135° 10, 90° 30, sharper ∞, plus a
// little per mm of length. Track ends (pads, vias) never move.

type XY = [number, number]

const ANGLE_COST = [0, 10, 30, Infinity, Infinity]

/** Clearance test for a straight piece of this track: true when it may go there. */
export type Clear = (a: XY, b: XY) => boolean

function dirIndex(a: XY, b: XY): number | undefined {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l = Math.hypot(dx, dy)
  if (l < 1e-9) return undefined
  const ang = Math.atan2(dy, dx)
  const k = Math.round((ang * 4) / Math.PI)
  // Not octilinear: no index (its corners count as acute).
  if (Math.abs(ang - (k * Math.PI) / 4) > 1e-3) return undefined
  return ((k % 8) + 8) % 8
}

function cornerCost(p: XY[]): number {
  let c = 0
  for (let i = 1; i < p.length; i++) c += 0.05 * Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
  for (let i = 1; i + 1 < p.length; i++) {
    const d1 = dirIndex(p[i - 1], p[i])
    const d2 = dirIndex(p[i], p[i + 1])
    if (d1 === undefined || d2 === undefined) {
      c += 50
      continue
    }
    const k = Math.min((d2 - d1 + 8) % 8, (d1 - d2 + 8) % 8)
    c += ANGLE_COST[k]
  }
  return c
}

/** The two-leg octilinear bridges from a to b (one if a→b is already octilinear). */
function bridges(a: XY, b: XY): XY[][] {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (Math.abs(dx) < 1e-9 || Math.abs(dy) < 1e-9 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-9) return [[a, b]]
  const m = Math.min(Math.abs(dx), Math.abs(dy))
  const d: XY = [Math.sign(dx) * m, Math.sign(dy) * m]
  const o: XY = [dx - d[0], dy - d[1]]
  return [
    [a, [a[0] + d[0], a[1] + d[1]], b],
    [a, [a[0] + o[0], a[1] + o[1]], b],
  ]
}

function mergeCollinear(p: XY[], keep: (q: XY) => boolean = () => false): XY[] {
  const out: XY[] = [p[0]]
  for (let i = 1; i < p.length; i++) {
    const q = p[i]
    const last = out[out.length - 1]
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) < 1e-6) continue
    if (out.length >= 2) {
      const a = out[out.length - 2]
      const cr = (last[0] - a[0]) * (q[1] - last[1]) - (last[1] - a[1]) * (q[0] - last[0])
      const dot = (last[0] - a[0]) * (q[0] - last[0]) + (last[1] - a[1]) * (q[1] - last[1])
      if (Math.abs(cr) < 1e-6 && dot > 0 && !keep(last)) {
        out[out.length - 1] = q
        continue
      }
    }
    out.push(q)
  }
  return out
}

const pathClear = (p: XY[], clear: Clear) => p.every((q, i) => i === 0 || clear(p[i - 1], q))

/**
 * Cleans a path. The first and last points stay; so do points in keep
 * (where other copper of the net joins). Pieces at the very ends may be
 * off-angle (a pad centre off the grid): they stay as short stubs.
 */
export function octilinear(path: XY[], clear: Clear, keep: (p: XY) => boolean = () => false): XY[] {
  let p = mergeCollinear(path, keep)
  if (p.length < 3) return p
  const fixed = (q: XY, i: number, arr: XY[]) => i === 0 || i === arr.length - 1 || keep(q)
  for (let round = 0; round < 12; round++) {
    let changed = false
    const cost = cornerCost(p)
    outer: for (let step = p.length - 1; step >= 2; step--) {
      for (let i = 0; i + step < p.length; i++) {
        // Do not jump over a point that must stay.
        let blocked = false
        for (let k = i + 1; k < i + step; k++) if (fixed(p[k], k, p)) blocked = true
        if (blocked) continue
        for (const br of bridges(p[i], p[i + step])) {
          const q = mergeCollinear([...p.slice(0, i), ...br, ...p.slice(i + step + 1)], keep)
          if (cornerCost(q) < cost - 1e-6 && pathClear(br, clear)) {
            p = q
            changed = true
            break outer
          }
        }
      }
    }
    if (!changed) break
  }
  // Chamfer the remaining right angles: the biggest 45° cut that fits.
  for (let i = 1; i + 1 < p.length; i++) {
    if (fixed(p[i], i, p)) continue
    const d1 = dirIndex(p[i - 1], p[i])
    const d2 = dirIndex(p[i], p[i + 1])
    if (d1 === undefined || d2 === undefined) continue
    const k = Math.min((d2 - d1 + 8) % 8, (d1 - d2 + 8) % 8)
    if (k !== 2) continue
    const la = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
    const lb = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1])
    const ua: XY = [(p[i - 1][0] - p[i][0]) / la, (p[i - 1][1] - p[i][1]) / la]
    const ub: XY = [(p[i + 1][0] - p[i][0]) / lb, (p[i + 1][1] - p[i][1]) / lb]
    // Keep at least a little straight track before the next corner.
    let hi = Math.min(la, lb) * 0.5
    let lo = 0
    for (let it = 0; it < 12; it++) {
      const m = (lo + hi) / 2
      const a: XY = [p[i][0] + ua[0] * m, p[i][1] + ua[1] * m]
      const b: XY = [p[i][0] + ub[0] * m, p[i][1] + ub[1] * m]
      if (clear(a, b)) lo = m
      else hi = m
    }
    if (lo > 0.05) {
      const a: XY = [p[i][0] + ua[0] * lo, p[i][1] + ua[1] * lo]
      const b: XY = [p[i][0] + ub[0] * lo, p[i][1] + ub[1] * lo]
      p = [...p.slice(0, i), a, b, ...p.slice(i + 1)]
      i++
    }
  }
  return mergeCollinear(p, keep)
}
