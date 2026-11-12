// Interactive routing: one leg of a track from a point to a point (or a pad)
// on a layer, around everything already on the board, by the autorouter's
// grid search. The two ends become tiny pads of the net, so the search, its
// clearances and the exact clean-up are exactly the autorouter's.

import type { Pcb, Track } from '../doc'
import { clearance } from './autoroute'
import type { ResolvedBoard } from './board'
import type { WorldPad } from './geometry'
import { octilinear } from './octilinear'
import { routeBoard } from './router'

type XY = [number, number]

export interface LegResult {
  points: XY[]
  layer: string
  width: number
  /** The straight segment was clear (no search needed). */
  straight: boolean
}

function dot(x: number, y: number, layer: string, net: string, k: number): WorldPad {
  const r = 0.01
  return { ref: `_leg${k}`, pin: '1', center: { x, y }, outline: [{ x: x - r, y: y - r }, { x: x + r, y: y - r }, { x: x + r, y: y + r }, { x: x - r, y: y + r }], layers: [layer], net }
}

/**
 * A route for net from a to c on layer: straight if that is clear, else the
 * grid search, cleaned to 0/45/90°. Undefined when there is no way through.
 */
export function routeLeg(pcb: Pcb, b: ResolvedBoard, net: string, layer: string, a: XY, c: XY, width?: number, budget = 4000): LegResult | undefined {
  const cls = b.netClass.get(net) ?? b.classes.get('default')!
  const w = width ?? cls.track
  const ok = clearance(b, pcb.tracks, pcb.vias)
  if (ok(net, layer, w, a, c)) return { points: [a, c], layer, width: w, straight: true }
  // Route only between the two ends: the net's own pads stay its copper (free to cross), but are
  // not targets, so they get a twin net name of the same class; the ends are the net's only pads.
  // A pad of the net under an end is that end itself.
  const under = (q: XY) => b.pads.find((p) => p.net === net && p.layers.includes(layer) && inside(q, p.outline))
  const [pa, pc] = [under(a), under(c)]
  const twin = `${net}\u0000own`
  const pads = b.pads.map((p) => (p.net === net && p !== pa && p !== pc ? { ...p, net: twin } : p))
  if (!pa) pads.push(dot(a[0], a[1], layer, net, 0))
  if (!pc) pads.push(dot(c[0], c[1], layer, net, 1))
  const board: ResolvedBoard = { ...b, pads, netClass: new Map(b.netClass) }
  board.netClass.set(twin, cls)
  // The twin pads are the net's copper: keep them in the netlist so they block only other nets.
  const sub: Pcb = { ...pcb, nets: [...pcb.nets, { name: twin, pins: [] }] }
  const r = routeBoard(sub, board, { only: new Set([net]), budget, iterations: 1 })
  if (r.unrouted.length || r.vias.length) return undefined
  const legs = r.tracks.filter((t) => t.net === net && t.layer === layer)
  if (!legs.length) return undefined
  // Join the pieces from a to c, then clean them up like the autorouter.
  const pts = join(legs, a)
  if (!pts) return undefined
  pts[0] = a
  pts[pts.length - 1] = c
  const tidy = octilinear(pts, (p, q) => ok(net, layer, w, p, q))
  return { points: tidy, layer, width: w, straight: false }
}

function inside(p: XY, poly: { x: number; y: number }[]): boolean {
  let ok = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, c] = [poly[i], poly[j]]
    if (a.y > p[1] !== c.y > p[1] && p[0] < ((c.x - a.x) * (p[1] - a.y)) / (c.y - a.y) + a.x) ok = !ok
  }
  return ok
}

function join(tracks: Track[], from: XY): XY[] | undefined {
  const left = tracks.map((t) => [...t.points] as XY[])
  const near = (p: XY, q: XY) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.15
  let i = left.findIndex((p) => near(p[0], from) || near(p[p.length - 1], from))
  if (i < 0) i = 0
  let path = left.splice(i, 1)[0]
  if (!near(path[0], from) && near(path[path.length - 1], from)) path.reverse()
  while (left.length) {
    const end = path[path.length - 1]
    const j = left.findIndex((p) => near(p[0], end) || near(p[p.length - 1], end))
    if (j < 0) return undefined
    const p = left.splice(j, 1)[0]
    if (!near(p[0], end)) p.reverse()
    path = path.concat(p.slice(1))
  }
  return path
}
