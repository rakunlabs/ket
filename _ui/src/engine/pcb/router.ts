// Ket's own autorouter: grid A* with 8 directions on each copper layer,
// negotiated congestion (PathFinder) and an octilinear clean-up, so routes
// look like a person drew them: 0/45/90° only, tracks leave pads along
// their long side, few vias, power nets at their class width.
//
// The grid (0.1 mm by default) is for searching only: a cell is free for a
// net class when a track of that class's width centered there keeps its
// clearance to every pad, hole and edge of the board (obstacles inflated
// per class). Tracks the router lays are marked on the grid the same way,
// so later nets keep clear of them. The result is checked against the exact
// geometry by Ket's DRC afterwards.
//
// Cost terms follow Freerouting's and KiCad's published numbers: straight
// step 1, diagonal √2·1.02, 45° turn +2, 90° turn +8, U-turn and acute
// turns forbidden, via +40 (4 mm of track), a mild "hug" cost next to other
// nets' copper so tracks keep even spacing, and PathFinder's present and
// history congestion costs. Nets go widest first, then shortest.

import { type Pcb, type Track, type Via, copperLayersOf } from '../doc'
import type { NetClass } from '../doc'
import type { ResolvedBoard } from './board'
import { DEFAULT_CLASS } from './board'
import type { WorldPad } from './geometry'

type XY = [number, number]

// Directions: 0 E, 1 NE, 2 N, 3 NW, 4 W, 5 SW, 6 S, 7 SE.
const DX = [1, 1, 0, -1, -1, -1, 0, 1]
const DY = [0, 1, 1, 1, 0, -1, -1, -1]
const STEP = [1, Math.SQRT2 * 1.02, 1, Math.SQRT2 * 1.02, 1, Math.SQRT2 * 1.02, 1, Math.SQRT2 * 1.02]
/** Cost of turning by k·45° (index = k, 0..4). */
const TURN = [0, 2, 8, Infinity, Infinity]
// About 6 mm of track: a via is worth it only for a real detour.
const VIA = 60
/** JLCPCB drill to drill, mm (edge to edge). */
const HOLE_TO_HOLE = 0.5 + 0.02
const NO_DIR = 8

export interface RouterOptions {
  pitch?: number
  /** Nets to route (default every net with 2+ pins). */
  only?: Set<string>
  skip?: Set<string>
  /** Wall-clock budget, ms. */
  budget?: number
  iterations?: number
}

export interface RouterResult {
  tracks: Track[]
  vias: Via[]
  unrouted: string[]
  iterations: number
}


function distPS(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

function insidePoly(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c
  }
  return c
}

/** Distance from a point to a polygon (0 inside). */
function distPoly(x: number, y: number, poly: { x: number; y: number }[]): number {
  if (insidePoly(x, y, poly)) return 0
  let d = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    d = Math.min(d, distPS(x, y, a.x, a.y, b.x, b.y))
  }
  return d
}

/** Binary min-heap of state ids keyed by f. */
class Heap {
  private ids: Int32Array
  private keys: Float64Array
  size = 0
  constructor(cap: number) {
    this.ids = new Int32Array(cap)
    this.keys = new Float64Array(cap)
  }
  push(id: number, key: number) {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.ids.length * 2)
      ids.set(this.ids)
      this.ids = ids
      const keys = new Float64Array(this.keys.length * 2)
      keys.set(this.keys)
      this.keys = keys
    }
    let i = this.size++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p] <= key) break
      this.ids[i] = this.ids[p]
      this.keys[i] = this.keys[p]
      i = p
    }
    this.ids[i] = id
    this.keys[i] = key
  }
  pop(): number {
    const top = this.ids[0]
    const id = this.ids[--this.size]
    const key = this.keys[this.size]
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= this.size) break
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++
      if (this.keys[c] >= key) break
      this.ids[i] = this.ids[c]
      this.keys[i] = this.keys[c]
      i = c
    }
    this.ids[i] = id
    this.keys[i] = key
    return top
  }
}

interface Conn {
  net: string
  cls: NetClass
  pads: WorldPad[]
}

/** One net's route: per layer, the grid cells it occupies, plus vias and polylines. */
interface NetRoute {
  cells: Map<number, number[]>
  paths: { layer: number; pts: XY[]; w: number }[]
  vias: XY[]
}

export function routeBoard(pcb: Pcb, b: ResolvedBoard, opts: RouterOptions = {}): RouterResult {
  const started = Date.now()
  const budget = opts.budget ?? 60_000
  const pitch = opts.pitch ?? 0.1
  const layerNames = copperLayersOf(b.layers)
  const L = layerNames.length
  const def = b.classes.get('default') ?? DEFAULT_CLASS
  const xs = b.outline.map((p) => p.x)
  const ys = b.outline.map((p) => p.y)
  // Fine-pitch pads leave room for a track only along their centre line:
  // shift the grid so as many pad centres as possible sit on it (weighted by
  // how narrow the pad is).
  const fit = (vals: { v: number; w: number }[], base: number) => {
    let best = 0
    let bestScore = -1
    for (let k = 0; k < 20; k++) {
      const off = (k / 20) * pitch
      let score = 0
      for (const { v, w } of vals) {
        const r = (((v - base - off) % pitch) + pitch) % pitch
        if (Math.min(r, pitch - r) < pitch * 0.06) score += w
      }
      if (score > bestScore) {
        bestScore = score
        best = off
      }
    }
    return best
  }
  const narrow = (p: WorldPad) => {
    const px = p.outline.map((q) => q.x)
    const py = p.outline.map((q) => q.y)
    return 1 / Math.max(0.1, Math.min(Math.max(...px) - Math.min(...px), Math.max(...py) - Math.min(...py)))
  }
  const routedPads = b.pads.filter((p) => p.net)
  const x0 = Math.min(...xs) + fit(routedPads.map((p) => ({ v: p.center.x, w: narrow(p) })), Math.min(...xs)) - pitch
  const y0 = Math.min(...ys) + fit(routedPads.map((p) => ({ v: p.center.y, w: narrow(p) })), Math.min(...ys)) - pitch
  const W = Math.ceil((Math.max(...xs) - x0) / pitch) + 2
  const H = Math.ceil((Math.max(...ys) - y0) / pitch) + 2
  const N = W * H
  const cx = (i: number) => x0 + (i % W) * pitch
  const cy = (i: number) => y0 + Math.floor(i / W) * pitch
  const cellOf = (x: number, y: number) => Math.round((y - y0) / pitch) * W + Math.round((x - x0) / pitch)

  // Nets to route.
  const nets: Conn[] = []
  for (const n of pcb.nets) {
    if (opts.skip?.has(n.name) || (opts.only && !opts.only.has(n.name))) continue
    const pads = b.pads.filter((p) => p.net === n.name)
    if (pads.length < 2) continue
    nets.push({ net: n.name, cls: b.netClass.get(n.name) ?? def, pads })
  }
  const classes = [...new Set(nets.map((n) => n.cls))]
  const netId = new Map<string, number>()
  pcb.nets.forEach((n, i) => netId.set(n.name, i + 1))

  // Static obstacles per class and layer: 0 free, else owner net id + 1 (65535 = no net / edge).
  // A cell is blocked for class c if a track of width w_c centred there would
  // come within clearance of a pad, hole, existing track or via, or the edge.
  const EDGE = 65535
  const blocked = new Map<NetClass, Uint16Array>()
  const edges: [number, number, number, number][] = []
  for (const poly of [b.outline, ...b.cutouts]) for (let i = 0; i < poly.length; i++) edges.push([poly[i].x, poly[i].y, poly[(i + 1) % poly.length].x, poly[(i + 1) % poly.length].y])
  const onBoard = (x: number, y: number) => insidePoly(x, y, b.outline) && !b.cutouts.some((c) => insidePoly(x, y, c))
  type Obs = { layers: Set<number>; net: number; dist: (x: number, y: number) => number; box: [number, number, number, number] }
  const obstacles: Obs[] = []
  const li = (name: string) => layerNames.indexOf(name as never)
  for (const p of b.pads) {
    const px = p.outline.map((q) => q.x)
    const py = p.outline.map((q) => q.y)
    obstacles.push({ layers: new Set(p.layers.map(li).filter((x) => x >= 0)), net: p.net ? netId.get(p.net) ?? 0 : 0, dist: (x, y) => distPoly(x, y, p.outline), box: [Math.min(...px), Math.min(...py), Math.max(...px), Math.max(...py)] })
  }
  const all = new Set(layerNames.map((_, i) => i))
  for (const h of b.holes) obstacles.push({ layers: all, net: 0, dist: (x, y) => Math.max(0, Math.hypot(x - h.at.x, y - h.at.y) - h.d / 2), box: [h.at.x - h.d / 2, h.at.y - h.d / 2, h.at.x + h.d / 2, h.at.y + h.d / 2] })
  for (const p of b.pads) if (p.drill) {
    const [a, c] = p.drillSlot ?? [p.center, p.center], r = p.drill / 2
    obstacles.push({ layers: all, net: p.drillPlated !== false && p.net ? netId.get(p.net) ?? 0 : 0, dist: (x, y) => Math.max(0, distPS(x, y, a.x, a.y, c.x, c.y) - r), box: [Math.min(a.x, c.x) - r, Math.min(a.y, c.y) - r, Math.max(a.x, c.x) + r, Math.max(a.y, c.y) + r] })
  }
  // Keep-outs that forbid tracks: copper of no net, so no track of any net comes within clearance.
  for (const k of b.keepouts) {
    if (!k.forbid.has('tracks')) continue
    const kx = k.polygon.map((q) => q.x)
    const ky = k.polygon.map((q) => q.y)
    obstacles.push({ layers: new Set(k.layers.map(li).filter((x) => x >= 0)), net: 0, dist: (x, y) => distPoly(x, y, k.polygon), box: [Math.min(...kx), Math.min(...ky), Math.max(...kx), Math.max(...ky)] })
  }
  const viaKeepouts = b.keepouts.filter((k) => k.forbid.has('vias'))
  const routedNets = new Set(nets.map((n) => n.net))
  for (const t of pcb.tracks) {
    if (routedNets.has(t.net)) continue
    for (let i = 1; i < t.points.length; i++) {
      const [ax, ay] = t.points[i - 1]
      const [bx, by] = t.points[i]
      const r = t.width / 2
      obstacles.push({ layers: new Set([li(t.layer)]), net: netId.get(t.net) ?? 0, dist: (x, y) => Math.max(0, distPS(x, y, ax, ay, bx, by) - r), box: [Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r] })
    }
  }
  for (const v of pcb.vias) {
    if (routedNets.has(v.net)) continue
    obstacles.push({ layers: all, net: netId.get(v.net) ?? 0, dist: (x, y) => Math.max(0, Math.hypot(x - v.at[0], y - v.at[1]) - v.diameter / 2), box: [v.at[0] - v.diameter / 2, v.at[1] - v.diameter / 2, v.at[0] + v.diameter / 2, v.at[1] + v.diameter / 2] })
  }
  // Pad entry: a pad's long axis gives its preferred exit directions.
  const padDirs = (p: WorldPad): number[] => {
    const o = p.outline
    if (o.length < 4 || o.length > 4) return [0, 2, 4, 6]
    const e1 = Math.hypot(o[1].x - o[0].x, o[1].y - o[0].y)
    const e2 = Math.hypot(o[2].x - o[1].x, o[2].y - o[1].y)
    const a = e1 >= e2 ? Math.atan2(o[1].y - o[0].y, o[1].x - o[0].x) : Math.atan2(o[2].y - o[1].y, o[2].x - o[1].x)
    if (Math.abs(e1 - e2) < 0.05) return [0, 2, 4, 6]
    const d = ((Math.round((a * 4) / Math.PI) % 8) + 8) % 8
    return [d, (d + 4) % 8]
  }

  const edgeGap = Math.max(0.3, def.clearance)
  for (const c of classes) {
    const g = new Uint16Array(N * L)
    const half = c.track / 2
    const reach = half + c.clearance
    for (let i = 0; i < N; i++) {
      const x = cx(i)
      const y = cy(i)
      let bad = !onBoard(x, y)
      if (!bad) for (const [ax, ay, bx, by] of edges) if (distPS(x, y, ax, ay, bx, by) < half + edgeGap) { bad = true; break }
      if (bad) for (let l = 0; l < L; l++) g[l * N + i] = EDGE
    }
    for (const o of obstacles) {
      const [bx0, by0, bx1, by1] = o.box
      const i0 = Math.max(0, Math.floor((bx0 - reach - x0) / pitch))
      const i1 = Math.min(W - 1, Math.ceil((bx1 + reach - x0) / pitch))
      const j0 = Math.max(0, Math.floor((by0 - reach - y0) / pitch))
      const j1 = Math.min(H - 1, Math.ceil((by1 + reach - y0) / pitch))
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const cell = j * W + i
          const d = o.dist(cx(cell), cy(cell))
          // A net's own copper: free for it (marked with its id), blocked for others.
          if (d >= reach) continue
          for (const l of o.layers) {
            const k = l * N + cell
            if (g[k] === EDGE) continue
            g[k] = o.net && (g[k] === 0 || g[k] === o.net) ? o.net : EDGE
          }
        }
    }
    blocked.set(c, g)
  }
  // Inside a pad's own copper is always its net's: the clearance zones of
  // neighbouring fine-pitch pads must not close it (the track starts there).
  for (const g2 of blocked.values()) {
    for (const p of b.pads) {
      if (!p.net) continue
      const id = netId.get(p.net) ?? 0
      const px = p.outline.map((q) => q.x)
      const py = p.outline.map((q) => q.y)
      const i0 = Math.max(0, Math.floor((Math.min(...px) - x0) / pitch))
      const i1 = Math.min(W - 1, Math.ceil((Math.max(...px) - x0) / pitch))
      const j0 = Math.max(0, Math.floor((Math.min(...py) - y0) / pitch))
      const j1 = Math.min(H - 1, Math.ceil((Math.max(...py) - y0) / pitch))
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const cell = j * W + i
          if (!insidePoly(cx(cell), cy(cell), p.outline)) continue
          for (const l of p.layers.map(li)) if (l >= 0) g2[l * N + cell] = id
        }
    }
  }
  // Escape corridors: from each fine-pitch pad, straight out along its long
  // axis, the cells where a track of the default width keeps clearance from
  // everything of other nets (exact check). Wide nets neck down there.
  for (const p of b.pads) {
    if (!p.net) continue
    const id = netId.get(p.net) ?? 0
    const cls = b.netClass.get(p.net) ?? def
    const w = Math.min(cls.track, def.track)
    const dirs = padDirs(p)
    if (dirs.length !== 2) continue
    for (const d of dirs) {
      for (let s = 0; s < 40; s++) {
        const x = p.center.x + DX[d] * s * pitch
        const y = p.center.y + DY[d] * s * pitch
        const cell = cellOf(x, y)
        if (cell < 0 || cell >= N) break
        // Checked at the exact pad axis (the track will be snapped onto it),
        // with a little tolerance for the grid offset.
        const ok = obstacles.every((o) => o.net === id || o.dist(x, y) >= w / 2 + cls.clearance) && onBoard(x, y) && edges.every(([ax, ay, bx, by]) => distPS(x, y, ax, ay, bx, by) >= w / 2 + edgeGap)
        if (!ok) break
        let opened = false
        for (const g2 of blocked.values())
          for (const l of p.layers.map(li)) {
            if (l < 0) continue
            const k = l * N + cell
            if (g2[k] === EDGE) {
              g2[k] = id
              opened = true
            }
          }
        // Out of the crowd (past the pad and the cells are free anyway): stop.
        if (!opened && !insidePoly(x, y, p.outline) && s > 2) break
      }
    }
  }

  // Dynamic occupancy by routed tracks. usage: how many nets' keep-out
  // zones (track half width + clearance + the widest track's half width
  // around each path cell) cover a cell; owner: the last of them. A path
  // cell inside another net's zone is a conflict.
  const usage = new Uint8Array(N * L)
  const owner = new Uint16Array(N * L)
  // Path cells only (the track centre line), per layer: the net id, 0 free.
  const path = new Uint16Array(N * L)
  const hist = new Float32Array(N * L)
  // Cells near copper of another net: the "hug" cost keeps even spacing.
  const near = new Uint16Array(N * L)

  const routes = new Map<string, NetRoute>()
  const state = (cell: number, layer: number, dir: number) => (layer * N + cell) * 9 + dir
  const S = N * L * 9
  const g = new Float32Array(S)
  const parent = new Int32Array(S)
  const stamp = new Uint32Array(S)
  let epoch = 0

  /** Cells (per layer) a track of class c centred on path cells covers: its own width plus clearance. */
  const footprint = (c: NetClass) => {
    const r = c.track / 2 + c.clearance + Math.max(...classes.map((x) => x.track)) / 2
    const k = Math.ceil(r / pitch)
    const offs: number[] = []
    for (let dj = -k; dj <= k; dj++) for (let di = -k; di <= k; di++) if (Math.hypot(di, dj) * pitch < r) offs.push(dj * W + di)
    return offs
  }
  const fp = new Map(classes.map((c) => [c, footprint(c)]))

  const occupy = (net: Conn, r: NetRoute, sign: 1 | -1) => {
    const id = netId.get(net.net)!
    const offs = fp.get(net.cls)!
    const seen = new Set<number>()
    // A via keeps others away on every layer, by its own (wider) radius.
    const vr = net.cls.via_diameter / 2 + net.cls.clearance + Math.max(...classes.map((x) => x.track)) / 2
    const vk = Math.ceil(vr / pitch)
    for (const [vx, vy] of r.vias) {
      const c = cellOf(vx, vy)
      for (let dj = -vk; dj <= vk; dj++)
        for (let di = -vk; di <= vk; di++) {
          if (Math.hypot(di, dj) * pitch >= vr) continue
          const n2 = c + dj * W + di
          if (n2 < 0 || n2 >= N) continue
          for (let l = 0; l < L; l++) {
            const k = l * N + n2
            if (seen.has(k)) continue
            seen.add(k)
            usage[k] = Math.max(0, usage[k] + sign)
            if (sign > 0) owner[k] = id
          }
        }
    }
    for (const [layer, cells] of r.cells) {
      for (const c of cells) {
        const pk = layer * N + c
        if (sign > 0) path[pk] = id
        else if (path[pk] === id) path[pk] = 0
        for (const o of offs) {
          const k = layer * N + c + o
          if (c + o < 0 || c + o >= N || seen.has(k)) continue
          seen.add(k)
          usage[k] = Math.max(0, usage[k] + sign)
          if (sign > 0) owner[k] = id
        }
        // A ring further out for the hug cost.
        for (let dj = -4; dj <= 4; dj++)
          for (let di = -4; di <= 4; di++) {
            const n2 = c + dj * W + di
            if (n2 < 0 || n2 >= N) continue
            const k = layer * N + n2
            near[k] = Math.max(0, near[k] + sign)
          }
      }
    }
  }

  /**
   * A* from the net's existing copper (sources) to one pad (target cells).
   * pres: present-congestion factor. Returns the path as states, or undefined.
   */
  const search = (net: Conn, sources: { cell: number; layer: number; dir: number }[], target: WorldPad, pres: number, box: [number, number, number, number]): number[] | undefined => {
    epoch++
    const id = netId.get(net.net)!
    const blk = blocked.get(net.cls)!
    const tCells = new Set<number>()
    const tLayers = target.layers.map(li).filter((x) => x >= 0)
    const tc = cellOf(target.center.x, target.center.y)
    tCells.add(tc)
    const tx = tc % W
    const ty = Math.floor(tc / W)
    const exits = padDirs(target)
    const heap = new Heap(1 << 16)
    const h = (cell: number, layer: number) => {
      const dx = Math.abs((cell % W) - tx)
      const dy = Math.abs(Math.floor(cell / W) - ty)
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy) + (tLayers.includes(layer) ? 0 : VIA)
    }
    for (const s of sources) {
      const st = state(s.cell, s.layer, s.dir)
      stamp[st] = epoch
      g[st] = 0
      parent[st] = -1
      heap.push(st, h(s.cell, s.layer))
    }
    const [bx0, by0, bx1, by1] = box
    let pops = 0
    while (heap.size) {
      const st = heap.pop()
      if (++pops > 4_000_000) return undefined
      const dir = st % 9
      const lc = (st - dir) / 9
      const layer = Math.floor(lc / N)
      const cell = lc - layer * N
      const gc = g[st]
      if (tCells.has(cell) && tLayers.includes(layer)) {
        // Arriving into a pad off its long axis costs: re-check on the way in.
        const path: number[] = []
        for (let s = st; s !== -1; s = parent[s]) path.push(s)
        return path.reverse()
      }
      const i = cell % W
      const j = (cell - i) / W
      for (let d = 0; d < 8; d++) {
        let turn = 0
        if (dir !== NO_DIR) {
          const k = Math.min((d - dir + 8) % 8, (dir - d + 8) % 8)
          turn = TURN[k]
          if (turn === Infinity) continue
        }
        const ni = i + DX[d]
        const nj = j + DY[d]
        if (ni < bx0 || ni > bx1 || nj < by0 || nj > by1) continue
        const nc = nj * W + ni
        const k = layer * N + nc
        const bv = blk[k]
        if (bv !== 0 && bv !== id) continue
        // Diagonal moves must not cut a blocked corner.
        if (d & 1) {
          const k1 = layer * N + j * W + ni
          const k2 = layer * N + nj * W + i
          if ((blk[k1] !== 0 && blk[k1] !== id) || (blk[k2] !== 0 && blk[k2] !== id)) continue
        }
        let cost = STEP[d] + turn
        // Leaving or entering a pad sideways (off its long axis).
        if (dir === NO_DIR && sources.length && !sourceDirs(cell, layer).includes(d)) cost += 10
        if (tCells.has(nc) && !exits.includes((d + 4) % 8)) cost += 10
        // Inside another net's keep-out zone (usage counts zones; ours is not there while we route).
        const other = usage[k] > 0
        if (other) cost += (1 + hist[k]) * pres * usage[k] * 4
        else cost += hist[k] * 0.5
        if (near[k] && owner[k] !== id) cost += 0.3
        const ns = state(nc, layer, d)
        const ng = gc + cost
        if (stamp[ns] !== epoch || ng < g[ns]) {
          stamp[ns] = epoch
          g[ns] = ng
          parent[ns] = st
          heap.push(ns, ng + h(nc, layer) * 1.0001)
        }
      }
      // Via to the other layers (not on a pad of another net, which blk covers).
      if (L > 1 && dir !== NO_DIR) {
        for (let nl = 0; nl < L; nl++) {
          if (nl === layer) continue
          const k = nl * N + cell
          const bv = blk[k]
          if (bv !== 0 && bv !== id) continue
          if (!viaFits(net, cell, id)) continue
          const ns = state(cell, nl, NO_DIR)
          const ng = gc + VIA * (L === 4 && Math.abs(nl - layer) > 1 ? 1.2 : 1)
          if (stamp[ns] !== epoch || ng < g[ns]) {
            stamp[ns] = epoch
            g[ns] = ng
            parent[ns] = st
            heap.push(ns, ng + h(cell, nl) * 1.0001)
          }
        }
      }
    }
    return undefined
  }

  // Where each pad lets a track leave, for the start states.
  const padExit = new Map<number, number[]>()
  const sourceDirs = (cell: number, layer: number) => padExit.get(layer * N + cell) ?? [0, 1, 2, 3, 4, 5, 6, 7]

  // A via needs room for its diameter on every layer.
  const viaOffs = new Map<NetClass, number[]>()
  const viaFits = (net: Conn, cell: number, id: number) => {
    let offs = viaOffs.get(net.cls)
    if (!offs) {
      // The via pad beyond the track's own width, plus half a cell for the grid.
      const r = net.cls.via_diameter / 2 - net.cls.track / 2 + pitch * 0.75
      const k = Math.ceil(r / pitch)
      offs = []
      for (let dj = -k; dj <= k; dj++) for (let di = -k; di <= k; di++) if (Math.hypot(di, dj) * pitch <= r) offs.push(dj * W + di)
      viaOffs.set(net.cls, offs)
    }
    const blk = blocked.get(net.cls)!
    // Drill to drill: the via's hole keeps holeToHole from every other hole
    // (mounting, part pins and pegs, plated pins), whatever their net.
    {
      const x = cx(cell)
      const y = cy(cell)
      const vd = net.cls.via_drill / 2
      for (const h of b.holes) if (Math.hypot(x - h.at.x, y - h.at.y) - h.d / 2 - vd < HOLE_TO_HOLE) return false
      // A via goes through every layer: any keep-out that forbids vias stops it.
      for (const k of viaKeepouts) if (distPoly(x, y, k.polygon) < net.cls.via_diameter / 2 + net.cls.clearance) return false
      for (const p of b.pads) if (p.drill) {
        const [a, c] = p.drillSlot ?? [p.center, p.center]
        if (distPS(x, y, a.x, a.y, c.x, c.y) - p.drill / 2 - vd < HOLE_TO_HOLE) return false
      }
    }
    for (let l = 0; l < L; l++)
      for (const o of offs) {
        const c = cell + o
        if (c < 0 || c >= N) return false
        const v = blk[l * N + c]
        if (v !== 0 && v !== id) return false
        // Not in another net's routed keep-out zone.
        if (usage[l * N + c] > 0) return false
        // Not on a pad of its own net (via in pad).
        if (v === id && b.pads.some((p) => p.net === net.net && distPoly(cx(c), cy(c), p.outline) === 0)) return false
      }
    return true
  }

  /** Routes one net: a tree grown from its first pad, nearest pad next. */
  const routeNet = (net: Conn, pres: number): NetRoute | undefined => {
    const r: NetRoute = { cells: new Map(), paths: [], vias: [] }
    const add = (layer: number, cell: number) => {
      if (!r.cells.has(layer)) r.cells.set(layer, [])
      r.cells.get(layer)!.push(cell)
    }
    const left = [...net.pads]
    // Start from the pad nearest to the others' centre of mass... the first is fine.
    const first = left.shift()!
    const tree: { cell: number; layer: number; dir: number }[] = []
    const seed = (p: WorldPad) => {
      const c = cellOf(p.center.x, p.center.y)
      for (const l of p.layers.map(li).filter((x) => x >= 0)) {
        tree.push({ cell: c, layer: l, dir: NO_DIR })
        padExit.set(l * N + c, padDirs(p))
      }
    }
    seed(first)
    while (left.length) {
      // Nearest remaining pad to the tree.
      let bi = 0
      let bd = Infinity
      left.forEach((p, i) => {
        for (const t of tree) {
          const d = Math.hypot(cx(t.cell) - p.center.x, cy(t.cell) - p.center.y)
          if (d < bd) {
            bd = d
            bi = i
          }
        }
      })
      const target = left.splice(bi, 1)[0]
      // Search box: the pads and the tree, plus a margin; widened on failure.
      let path: number[] | undefined
      for (const margin of [3, 8, 1e9]) {
        let ax = target.center.x
        let ay = target.center.y
        let bx = ax
        let by = ay
        for (const t of tree) {
          ax = Math.min(ax, cx(t.cell))
          ay = Math.min(ay, cy(t.cell))
          bx = Math.max(bx, cx(t.cell))
          by = Math.max(by, cy(t.cell))
        }
        const box: [number, number, number, number] = [
          Math.max(0, Math.floor((ax - margin - x0) / pitch)),
          Math.max(0, Math.floor((ay - margin - y0) / pitch)),
          Math.min(W - 1, Math.ceil((bx + margin - x0) / pitch)),
          Math.min(H - 1, Math.ceil((by + margin - y0) / pitch)),
        ]
        path = search(net, tree, target, pres, box)
        if (path) break
      }
      if (!path) return undefined
      // Path states → cells per layer, polylines and vias.
      let cur: { layer: number; pts: XY[] } | undefined
      let lastLayer = -1
      for (const st of path) {
        const dir = st % 9
        const lc = (st - dir) / 9
        const layer = Math.floor(lc / N)
        const cell = lc - layer * N
        add(layer, cell)
        tree.push({ cell, layer, dir: NO_DIR })
        tree.push({ cell, layer, dir })
        const pt: XY = [cx(cell), cy(cell)]
        if (layer !== lastLayer) {
          if (cur && cur.pts.length > 1) r.paths.push({ layer: cur.layer, pts: cur.pts, w: net.cls.track })
          if (lastLayer >= 0) r.vias.push(pt)
          cur = { layer, pts: [pt] }
          lastLayer = layer
        } else cur!.pts.push(pt)
      }
      if (cur && cur.pts.length > 1) r.paths.push({ layer: cur.layer, pts: cur.pts, w: net.cls.track })
      seed(target)
    }
    return r
  }

  // Order: nets on fine-pitch pads first (their escapes are the tightest),
  // then widest, then by bounding-box half perimeter (short first).
  const hp = (n: Conn) => {
    const xs2 = n.pads.map((p) => p.center.x)
    const ys2 = n.pads.map((p) => p.center.y)
    return Math.max(...xs2) - Math.min(...xs2) + Math.max(...ys2) - Math.min(...ys2)
  }
  const fine = (n: Conn) => n.pads.some((p) => b.pads.some((q) => q !== p && q.ref === p.ref && Math.hypot(q.center.x - p.center.x, q.center.y - p.center.y) < 0.8))
  const order = [...nets].sort((a, c) => Number(fine(c)) - Number(fine(a)) || c.cls.track - a.cls.track || hp(a) - hp(c))

  // Negotiated congestion: route everyone, raise the cost of shared cells, reroute the ones that share.
  let pres = 0.5
  const maxIter = opts.iterations ?? 30
  let iter = 0
  let failed = new Set<string>()
  let bestBad = Infinity
  let stale = 0
  for (; iter < maxIter; iter++) {
    failed = new Set()
    const reroute = iter === 0 ? order : order.filter((n) => conflicts(n))
    if (iter > 0 && !reroute.length) break
    // No progress for a while: the rest is for rip-up.
    if (reroute.length < bestBad) {
      bestBad = reroute.length
      stale = 0
    } else if (++stale >= 6) break
    for (const n of reroute) {
      const old = routes.get(n.net)
      if (old) occupy(n, old, -1)
      const r = routeNet(n, pres)
      if (r) {
        routes.set(n.net, r)
        occupy(n, r, 1)
      } else {
        routes.delete(n.net)
        failed.add(n.net)
      }
      if (Date.now() - started > budget) break
    }
    // History: every overused cell gets more expensive for the next round.
    for (let k = 0; k < usage.length; k++) if (path[k] && (usage[k] > 1 || owner[k] !== path[k])) hist[k] += 1
    pres *= 1.6
    if (Date.now() - started > budget) break
  }

  /** A net's track runs through another net's keep-out zone. */
  function conflicts(n: Conn): boolean {
    const r = routes.get(n.net)
    if (!r) return true
    const id = netId.get(n.net)!
    for (const [layer, cells] of r.cells)
      for (const c of cells) {
        const k = layer * N + c
        if (usage[k] > 1 || (usage[k] === 1 && owner[k] !== id)) return true
      }
    return false
  }

  // Nets still sharing cells after the last round are given up (left unrouted).
  for (const n of order) if (conflicts(n) && routes.has(n.net)) {
    occupy(n, routes.get(n.net)!, -1)
    routes.delete(n.net)
    failed.add(n.net)
  }

  // Rip-up and reroute: a net that failed goes first on a board without
  // the nets it would cross, then those nets are routed again around it.
  // Kept only if more nets end up routed.
  for (let pass = 0; pass < 3 && failed.size && Date.now() - started < budget; pass++) {
    const before = new Set(routes.keys())
    const saved = new Map(routes)
    const snapshot = { usage: usage.slice(), owner: owner.slice(), path: path.slice(), near: near.slice() }
    for (const name of [...failed]) {
      const n = nets.find((x) => x.net === name)!
      // Free the board of everything, route this one, then the others in order.
      for (const [k, r] of routes) occupy(nets.find((x) => x.net === k)!, r, -1)
      routes.clear()
      const first = routeNet(n, 0)
      if (!first) continue
      routes.set(n.net, first)
      occupy(n, first, 1)
      const left: string[] = []
      for (const m of order) {
        if (m === n || !before.has(m.net)) continue
        const r = routeNet(m, 1e6)
        if (r) {
          routes.set(m.net, r)
          occupy(m, r, 1)
          if (conflicts(m)) {
            occupy(m, r, -1)
            routes.delete(m.net)
            left.push(m.net)
          }
        } else left.push(m.net)
      }
      if (routes.size > saved.size) {
        failed.delete(n.net)
        for (const l of left) failed.add(l)
        break
      }
      // Worse: put everything back.
      for (const [k, r] of routes) occupy(nets.find((x) => x.net === k)!, r, -1)
      routes.clear()
      for (const [k, r] of saved) routes.set(k, r)
      usage.set(snapshot.usage)
      owner.set(snapshot.owner)
      path.set(snapshot.path)
      near.set(snapshot.near)
    }
    if (routes.size <= saved.size) break
  }

  const tracks: Track[] = []
  const vias: Via[] = []
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  for (const n of order) {
    const r = routes.get(n.net)
    if (!r) continue
    // Points where another branch of the net starts or ends: they must stay
    // on this track (and as corners, so the clean-up keeps them).
    const joints = new Set<string>()
    for (const p of r.paths) for (const e of [p.pts[0], p.pts[p.pts.length - 1]]) joints.add(`${p.layer}:${e[0]},${e[1]}`)
    for (const p of r.paths) {
      const keepPts = p.pts.filter((q, i) => i === 0 || i === p.pts.length - 1 || joints.has(`${p.layer}:${q[0]},${q[1]}`))
      // Merge collinear runs but keep the joints.
      const pts: XY[] = []
      let seg: XY[] = []
      for (const q of p.pts) {
        seg.push(q)
        if (keepPts.includes(q) && seg.length > 1) {
          const m = mergeCollinear(seg)
          pts.push(...(pts.length ? m.slice(1) : m))
          seg = [q]
        }
      }
      // A track is only moved onto a pad centre at an end that is not a joint.
      const isJoint = (q: XY) => joints.has(`${p.layer}:${q[0]},${q[1]}`) && r.paths.filter((o) => o.layer === p.layer && o.pts.some((x) => x[0] === q[0] && x[1] === q[1])).length > 1
      // Pad centres are off the grid: the straight run into a pad is moved
      // onto the pad's axis, and the track ends on its centre.
      const snapEnd = (at: number, next: number) => {
        const q = pts[at]
        if (isJoint(q)) return
        const pad = n.pads.find((pd) => insidePoly(q[0], q[1], pd.outline) || Math.hypot(pd.center.x - q[0], pd.center.y - q[1]) < pitch * 0.75)
        if (!pad) return
        const c: XY = [pad.center.x, pad.center.y]
        if (Math.hypot(c[0] - q[0], c[1] - q[1]) < 1e-6) return
        const r = pts[next]
        const horiz = Math.abs(r[1] - q[1]) < 1e-9
        const vert = Math.abs(r[0] - q[0]) < 1e-9
        // Slide the last leg onto the pad's centre line when it runs straight
        // (the corridor was checked there), unless its other end is a joint.
        const slide = pts.length > 2 && !isJoint(r)
        if (horiz && slide) {
          pts[next] = [r[0], c[1]]
          pts[at] = c
        } else if (vert && slide) {
          pts[next] = [c[0], r[1]]
          pts[at] = c
        } else if ((horiz || vert) && !isJoint(r) && pts.length === 2) {
          pts[at] = c
          pts[next] = horiz ? [r[0], c[1]] : [c[0], r[1]]
        } else {
          // A short stub from the grid point into the pad centre.
          pts.splice(at === 0 ? 0 : pts.length, 0, c)
        }
      }
      snapEnd(pts.length - 1, pts.length - 2)
      snapEnd(0, 1)
      tracks.push({ net: n.net, layer: layerNames[p.layer] as Track['layer'], width: p.w, points: pts.map(([x, y]) => [r3(x), r3(y)] as XY) })
    }
    for (const v of r.vias) vias.push({ net: n.net, at: [r3(v[0]), r3(v[1])], drill: n.cls.via_drill, diameter: n.cls.via_diameter })
  }
  return { tracks, vias, unrouted: [...failed], iterations: iter }
}

function mergeCollinear(pts: XY[]): XY[] {
  const out: XY[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]
    const b = pts[i]
    const c = pts[i + 1]
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (Math.abs(cr) > 1e-9) out.push(b)
  }
  out.push(pts[pts.length - 1])
  return out
}
