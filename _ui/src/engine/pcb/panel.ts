// Panels: copies of one board in a grid with rails, for assembly lines that
// want several boards per frame. Each copy is the same resolved board moved
// by an offset; the panel outline, rails, V-score lines or mouse-bite tabs
// and fiducial/tooling holes are added. Everything goes through the same
// Gerber writer as a single board.

import type { P, Pcb } from '../doc'
import type { ResolvedBoard } from './board'
import type { Poly } from './geometry'
import type { Teardrop } from './teardrops'
import type { ZoneFill } from './zones'

export interface PanelOptions {
  nx: number
  ny: number
  /** Gap between boards, mm: 0 for V-score, about 2 for mouse bites. */
  gap?: number
  method: 'vscore' | 'mousebite'
  /** Rail width on the two long sides (or all four), mm. */
  rails?: number
  railsOn?: 'x' | 'y' | 'both' | 'none'
}

export interface Panel {
  pcb: Pcb
  board: ResolvedBoard
  zones: ZoneFill[]
  teardrops: Teardrop[]
  /** V-score lines (for the V-cut layer), panel mm. */
  vscore: [P, P][]
  width: number
  height: number
  notes: string[]
}

const mv = (p: P, dx: number, dy: number): P => ({ x: p.x + dx, y: p.y + dy })
const mvPoly = (poly: Poly, dx: number, dy: number) => poly.map((p) => mv(p, dx, dy))
const r3 = (v: number) => Math.round(v * 1000) / 1000

export function panelize(pcb: Pcb, b: ResolvedBoard, zones: ZoneFill[], drops: Teardrop[], o: PanelOptions): Panel {
  if (!(o.nx >= 1 && o.ny >= 1 && o.nx * o.ny <= 100)) throw new Error('nx and ny must be ≥ 1 with at most 100 boards per panel')
  const notes: string[] = []
  const gap = o.gap ?? (o.method === 'vscore' ? 0 : 2)
  if (o.method === 'vscore' && gap !== 0) throw new Error('V-score panels have no gap between boards (gap 0)')
  if (o.method === 'mousebite' && gap < 1.6) throw new Error('mouse-bite tabs need a gap of at least 1.6 mm (2 is usual)')
  const xs = b.outline.map((p) => p.x)
  const ys = b.outline.map((p) => p.y)
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  const [w, h] = [x1 - x0, y1 - y0]
  const rect = Math.abs(b.outline.length - 4) === 0 && b.cutouts.length === 0
  if (o.method === 'vscore' && !rect) throw new Error('V-score cuts run straight across the panel: the board outline must be a plain rectangle; use mousebite')
  const rails = o.rails ?? 5
  const railsOn = o.railsOn ?? 'x'
  const rx = railsOn === 'y' || railsOn === 'both' ? rails : 0
  const ry = railsOn === 'x' || railsOn === 'both' ? rails : 0
  // Board copies: lower-left corner of copy (i, j) at (rx + i (w + gap), ry + j (h + gap)).
  const offsets: [number, number][] = []
  for (let j = 0; j < o.ny; j++) for (let i = 0; i < o.nx; i++) offsets.push([rx + i * (w + gap) - x0, ry + j * (h + gap) - y0])
  const W = 2 * rx + o.nx * w + (o.nx - 1) * gap
  const H = 2 * ry + o.ny * h + (o.ny - 1) * gap

  const copies = offsets.map(([dx, dy], k) => ({ dx, dy, k }))
  const tag = (s: string, k: number) => `${s}_${k + 1}`
  const board: ResolvedBoard = {
    ...b,
    outline: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }],
    cutouts: [],
    components: copies.flatMap(({ dx, dy, k }) => b.components.map((c) => ({ ...c, ref: tag(c.ref, k), at: mv(c.at, dx, dy), courtyard: mvPoly(c.courtyard, dx, dy) }))),
    pads: copies.flatMap(({ dx, dy, k }) => b.pads.map((p) => ({ ...p, ref: tag(p.ref, k), center: mv(p.center, dx, dy), outline: mvPoly(p.outline, dx, dy), ...(p.drillSlot ? { drillSlot: [mv(p.drillSlot[0], dx, dy), mv(p.drillSlot[1], dx, dy)] as [P, P] } : {}) }))),
    holes: copies.flatMap(({ dx, dy, k }) => b.holes.map((hh) => ({ ...hh, at: mv(hh.at, dx, dy), ...(hh.ref ? { ref: tag(hh.ref, k) } : {}) }))),
    artwork: (b.artwork ?? []).flatMap((art) => copies.map(({ dx, dy, k }) => ({ ...art, name: tag(art.name, k), at: [art.at[0] + dx, art.at[1] + dy] as [number, number], regions: art.regions.map((reg) => reg.map((ring) => mvPoly(ring, dx, dy))) }))),
    keepouts: [],
  }
  // Each board's outline (and cut-outs) is milled: mouse bites leave tabs, V-score boards touch.
  const routed: Poly[] = []
  const vscore: [P, P][] = []
  if (o.method === 'mousebite') {
    for (const { dx, dy } of copies) {
      routed.push(mvPoly(b.outline, dx, dy))
      for (const c of b.cutouts) routed.push(mvPoly(c, dx, dy))
    }
    // Tabs: a row of 0.5 mm holes 0.8 mm apart, on each side of a board that faces another board or a rail, in the middle of the side.
    const bite = (a: P, c: P) => {
      const len = Math.hypot(c.x - a.x, c.y - a.y)
      const u = { x: (c.x - a.x) / len, y: (c.y - a.y) / len }
      const mid = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }
      for (let k = -2; k <= 2; k++) board.holes.push({ at: { x: r3(mid.x + u.x * k * 0.8), y: r3(mid.y + u.y * k * 0.8) }, d: 0.5 })
    }
    for (const { dx, dy } of copies) {
      // Tabs sit in the gap, gap/2 out from the board edge.
      const g = gap / 2
      bite({ x: x0 + dx, y: y0 + dy - g }, { x: x1 + dx, y: y0 + dy - g })
      bite({ x: x0 + dx, y: y1 + dy + g }, { x: x1 + dx, y: y1 + dy + g })
      bite({ x: x0 + dx - g, y: y0 + dy }, { x: x0 + dx - g, y: y1 + dy })
      bite({ x: x1 + dx + g, y: y0 + dy }, { x: x1 + dx + g, y: y1 + dy })
    }
    notes.push('Mouse-bite tabs: 5 holes of 0.5 mm per side in the gap; the board outlines are milled. Check tab places against parts near the edge')
  } else {
    // V-scores: straight lines across the whole panel between rows and columns and at the rails.
    for (let i = 0; i <= o.nx; i++) {
      const x = rx + i * w
      if ((i === 0 || i === o.nx) && !rx) continue
      vscore.push([{ x, y: 0 }, { x, y: H }])
    }
    for (let j = 0; j <= o.ny; j++) {
      const y = ry + j * h
      if ((j === 0 || j === o.ny) && !ry) continue
      vscore.push([{ x: 0, y }, { x: W, y }])
    }
    notes.push('V-score lines are in board-V_Cut.gm2 and drawn on the outline layer as a reference; tell the fab the panel is V-scored')
  }
  // Tooling holes and fiducials in the rails.
  const fiducials: P[] = []
  if (ry) {
    for (const x of [5, W - 5]) for (const y of [ry / 2, H - ry / 2]) board.holes.push({ at: { x: r3(x), y: r3(y) }, d: 1.152 })
    fiducials.push({ x: 10, y: ry / 2 }, { x: W - 10, y: ry / 2 }, { x: 10, y: H - ry / 2 })
  } else if (rx) {
    for (const y of [5, H - 5]) for (const x of [rx / 2, W - rx / 2]) board.holes.push({ at: { x: r3(x), y: r3(y) }, d: 1.152 })
    fiducials.push({ x: rx / 2, y: 10 }, { x: rx / 2, y: H - 10 }, { x: W - rx / 2, y: 10 })
  } else notes.push('No rails: no room for tooling holes and fiducials; most assembly lines want 5 mm rails')
  if (rails && rails < 3) notes.push(`${rails} mm rails are narrow; JLCPCB asks for at least 5 mm for SMT assembly`)
  // Fiducials: 1 mm copper dots (2 mm mask opening), as pads of no net.
  for (const [i, f] of fiducials.entries()) {
    const ring = (r: number) => Array.from({ length: 24 }, (_, k) => ({ x: f.x + r * Math.cos((k / 24) * 2 * Math.PI), y: f.y + r * Math.sin((k / 24) * 2 * Math.PI) }))
    board.pads.push({ ref: `FID${i + 1}`, pin: '1', center: f, outline: ring(0.5), layers: ['F.Cu'] })
    board.pads.push({ ref: `FID${i + 1}`, pin: '2', center: f, outline: ring(0.5), layers: ['B.Cu'] })
  }
  ;(board as ResolvedBoard & { panelRouted?: Poly[]; panelVscore?: [P, P][] }).panelRouted = routed
  ;(board as ResolvedBoard & { panelVscore?: [P, P][] }).panelVscore = vscore

  const out: Pcb = {
    ...pcb,
    components: [],
    nets: pcb.nets.map((n) => ({ ...n, pins: copies.flatMap(({ k }) => n.pins.map((p) => `${tag(p.slice(0, p.indexOf('.')), k)}${p.slice(p.indexOf('.'))}`)) })),
    tracks: copies.flatMap(({ dx, dy }) => pcb.tracks.map((t) => ({ ...t, points: t.points.map(([x, y]) => [r3(x + dx), r3(y + dy)] as [number, number]) }))),
    vias: copies.flatMap(({ dx, dy }) => pcb.vias.map((v) => ({ ...v, at: [r3(v.at[0] + dx), r3(v.at[1] + dy)] as [number, number] }))),
    holes: [],
  }
  return {
    pcb: out,
    board,
    zones: copies.flatMap(({ dx, dy }) => zones.map((z) => ({ ...z, regions: z.regions.map((reg) => reg.map((ring) => mvPoly(ring, dx, dy))) }))),
    teardrops: copies.flatMap(({ dx, dy }) => drops.map((d) => ({ ...d, outline: mvPoly(d.outline, dx, dy) }))),
    vscore,
    width: r3(W),
    height: r3(H),
    notes,
  }
}
