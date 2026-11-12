// Fabrication outputs: Gerber X2 (RS-274X) per layer, Excellon drill,
// JLCPCB-style BOM and CPL. Regions are emitted as G36/G37 polygons, tracks
// as stroked lines with round apertures.

import { type Pcb, copperLayersOf, viaLayers } from '../doc'
import type { ResolvedBoard } from './board'
import type { Poly } from './geometry'
import type { Teardrop } from './teardrops'
import type { ZoneFill } from './zones'
import { rot } from './geometry'
import { boardDrills } from './drills'

const fmt = (mm: number) => Math.round(mm * 1e6).toString() // 4.6 format, mm

class Gerber {
  private apertures = new Map<string, number>()
  private body: string[] = []
  private next = 10

  constructor(
    private func: string,
    private filePolarity: 'Positive' | 'Negative' = 'Positive',
  ) {}

  private ap(def: string): number {
    let d = this.apertures.get(def)
    if (d === undefined) {
      d = this.next++
      this.apertures.set(def, d)
    }
    return d
  }

  /** Dark (add) or clear (subtract) polarity for following objects. */
  polarity(dark: boolean) {
    this.body.push(dark ? '%LPD*%' : '%LPC*%')
  }

  region(poly: Poly, holes: Poly[] = []) {
    if (poly.length < 3) return
    this.body.push('G36*')
    for (const ring of [poly, ...holes]) {
      this.body.push(`X${fmt(ring[0].x)}Y${fmt(ring[0].y)}D02*`)
      for (const p of ring.slice(1)) this.body.push(`X${fmt(p.x)}Y${fmt(p.y)}D01*`)
      this.body.push(`X${fmt(ring[0].x)}Y${fmt(ring[0].y)}D01*`)
    }
    this.body.push('G37*')
  }

  line(points: [number, number][], width: number) {
    if (points.length < 2) return
    this.body.push(`D${this.ap(`C,${width.toFixed(4)}`)}*`)
    this.body.push(`X${fmt(points[0][0])}Y${fmt(points[0][1])}D02*`)
    for (const p of points.slice(1)) this.body.push(`X${fmt(p[0])}Y${fmt(p[1])}D01*`)
  }

  flash(x: number, y: number, d: number) {
    this.body.push(`D${this.ap(`C,${d.toFixed(4)}`)}*`)
    this.body.push(`X${fmt(x)}Y${fmt(y)}D03*`)
  }

  toString(): string {
    const head = [
      `%TF.GenerationSoftware,ket,ket,1*%`,
      `%TF.FileFunction,${this.func}*%`,
      `%TF.FilePolarity,${this.filePolarity}*%`,
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%LPD*%',
      'G01*',
      'G75*',
    ]
    for (const [def, d] of this.apertures) head.push(`%ADD${d}${def}*%`)
    return [...head, ...this.body, 'M02*', ''].join('\n')
  }
}

function grow(poly: Poly, d: number): Poly {
  // Offset a convex-ish pad outline outwards from its centroid (good enough
  // for solder mask expansion of pads).
  const c = poly.reduce((a, p) => ({ x: a.x + p.x / poly.length, y: a.y + p.y / poly.length }), { x: 0, y: 0 })
  return poly.map((p) => {
    const dx = p.x - c.x
    const dy = p.y - c.y
    const l = Math.hypot(dx, dy) || 1
    return { x: p.x + (dx / l) * d, y: p.y + (dy / l) * d }
  })
}

export interface FabFiles {
  [name: string]: string
}

export function fabFiles(pcb: Pcb, b: ResolvedBoard, zones: ZoneFill[] = [], drops: Teardrop[] = []): FabFiles {
  const files: FabFiles = {}
  const copper = copperLayersOf(b.layers)
  const fn: Record<string, [string, string]> = {
    'F.Cu': ['board-F_Cu.gtl', 'Copper,L1,Top'],
    'In1.Cu': ['board-In1_Cu.g2', 'Copper,L2,Inr'],
    'In2.Cu': ['board-In2_Cu.g3', 'Copper,L3,Inr'],
    'In3.Cu': ['board-In3_Cu.g4', 'Copper,L4,Inr'],
    'In4.Cu': ['board-In4_Cu.g5', 'Copper,L5,Inr'],
    'B.Cu': ['board-B_Cu.gbl', `Copper,L${copper.length},Bot`],
  }

  for (const layer of copper) {
    const g = new Gerber(fn[layer][1])
    // Pours first: each outer dark, its holes cleared, then the rest dark.
    for (const z of zones) {
      if (z.layer !== layer) continue
      for (const reg of z.regions) {
        g.polarity(true)
        g.region(reg[0])
        if (reg.length > 1) {
          g.polarity(false)
          for (const h of reg.slice(1)) g.region(h)
        }
      }
    }
    g.polarity(true)
    for (const p of b.pads) if (p.layers.includes(layer)) g.region(p.outline)
    for (const t of pcb.tracks) if (t.layer === layer) g.line(t.points, t.width)
    for (const d of drops) if (d.layer === layer) g.region(d.outline)
    for (const v of pcb.vias) if (viaLayers(v, b.layers).includes(layer)) g.flash(v.at[0], v.at[1], v.diameter)
    files[fn[layer][0]] = g.toString()
  }

  for (const [side, file, func] of [
    ['F.Cu', 'board-F_Mask.gts', 'Soldermask,Top'],
    ['B.Cu', 'board-B_Mask.gbs', 'Soldermask,Bot'],
  ] as const) {
    const g = new Gerber(func, 'Negative')
    for (const p of b.pads) if (p.layers.includes(side)) g.region(grow(p.outline, 0.05))
    files[file] = g.toString()
  }

  for (const [side, file, func] of [
    ['top', 'board-F_Silkscreen.gto', 'Legend,Top'],
    ['bottom', 'board-B_Silkscreen.gbo', 'Legend,Bot'],
  ] as const) {
    const g = new Gerber(func)
    for (const c of b.components) {
      if (c.side !== side) continue
      for (const [x1, y1, x2, y2, w] of c.footprint.silk) {
        const m = (x: number, y: number): [number, number] => {
          const q = rot({ x: c.side === 'bottom' ? -x : x, y }, c.rotation)
          return [c.at.x + q.x, c.at.y + q.y]
        }
        g.line([m(x1, y1), m(x2, y2)], Math.max(w, 0.12))
      }
    }
    for (const art of b.artwork ?? []) {
      if (art.side !== side) continue
      for (const region of art.regions) g.region(region[0], region.slice(1))
    }
    files[file] = g.toString()
  }

  const edge = new Gerber('Profile,NP')
  // A panel also mills each board's outline (mouse bites) and marks its V-scores.
  const panel = b as ResolvedBoard & { panelRouted?: Poly[]; panelVscore?: [{ x: number; y: number }, { x: number; y: number }][] }
  for (const poly of [b.outline, ...b.cutouts, ...(panel.panelRouted ?? [])]) edge.line([...poly, poly[0]].map((p) => [p.x, p.y]), 0.1)
  files['board-Edge_Cuts.gm1'] = edge.toString()
  if (panel.panelVscore?.length) {
    const v = new Gerber('Vcut,NP')
    for (const [a, c] of panel.panelVscore) v.line([[a.x, a.y], [c.x, c.y]], 0.1)
    files['board-V_Cut.gm2'] = v.toString()
  }

  // Separate PTH/NPTH files: plating is machine-readable, not just a comment.
  // G85 slots carry both tool-center endpoints, already mirrored/rotated.
  // Blind and buried vias: one plated file per layer pair, as fabs expect (X2 FileFunction span).
  const spans = [...new Set(boardDrills(pcb, b).flatMap((h) => (h.span ? [h.span.join('-')] : [])))]
  for (const key of spans) {
    const [from, to] = key.split('-').map(Number)
    const hits = boardDrills(pcb, b).filter((h) => h.span?.join('-') === key)
    const tools = new Map<string, number>()
    for (const h of hits) if (!tools.has(h.d.toFixed(4))) tools.set(h.d.toFixed(4), tools.size + 1)
    const kind = from === 1 || to === b.layers ? 'Blind' : 'Buried'
    const drl = ['M48', `; #@! TF.FileFunction,Plated,${from},${to},${kind}`, '; FILE_FORMAT=4:4', 'FMAT,2', 'METRIC,TZ']
    for (const [d, tool] of tools) drl.push(`T${tool}C${d}`)
    drl.push('%', 'G90', 'G05')
    for (const [d, tool] of tools) {
      drl.push(`T${tool}`)
      for (const h of hits.filter((h) => h.d.toFixed(4) === d)) drl.push(`X${h.at.x.toFixed(4)}Y${h.at.y.toFixed(4)}`)
    }
    drl.push('T0', 'M30', '')
    files[`board-${kind}-L${from}-L${to}.drl`] = drl.join('\n')
  }

  for (const plated of [true, false]) {
    const hits = boardDrills(pcb, b).filter((h) => h.plated === plated && !h.span)
    const tools = new Map<string, number>()
    for (const h of hits) if (!tools.has(h.d.toFixed(4))) tools.set(h.d.toFixed(4), tools.size + 1)
    const drl = ['M48', `; #@! TF.FileFunction,${plated ? 'Plated' : 'NonPlated'},1,${b.layers},${plated ? 'PTH' : 'NPTH'}`, '; FILE_FORMAT=4:4', 'FMAT,2', 'METRIC,TZ']
    for (const [d, tool] of tools) drl.push(`T${tool}C${d}`)
    drl.push('%', 'G90', 'G05')
    const xy = (p: { x: number; y: number }) => `X${p.x.toFixed(4)}Y${p.y.toFixed(4)}`
    for (const [d, tool] of tools) {
      drl.push(`T${tool}`)
      for (const h of hits.filter((h) => h.d.toFixed(4) === d)) {
        const slot = Math.hypot(h.to.x - h.from.x, h.to.y - h.from.y) > 1e-9
        drl.push(slot ? `${xy(h.from)}G85${xy(h.to)}` : xy(h.at))
        if (slot) drl.push('G05')
      }
    }
    drl.push('T0', 'M30', '')
    files[plated ? 'board-PTH.drl' : 'board-NPTH.drl'] = drl.join('\n')
  }

  // BOM grouped by LCSC part, CPL per placement (JLCPCB column names).
  const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const groups = new Map<string, typeof b.components>()
  const fitted = b.components.filter((c) => !c.dnp)
  for (const c of fitted) {
    const k = c.lcsc || `${c.mpn}|${c.package}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(c)
  }
  files['bom.csv'] = [
    'Comment,Designator,Footprint,LCSC Part #',
    ...[...groups.values()].map((cs) => [cs[0].value ?? cs[0].mpn ?? '', cs.map((c) => c.ref).join(','), cs[0].package ?? cs[0].footprint.name, cs[0].lcsc].map(csv).join(',')),
  ].join('\n') + '\n'
  files['cpl.csv'] = [
    'Designator,Mid X,Mid Y,Layer,Rotation',
    ...fitted.map((c) => [c.ref, `${c.at.x.toFixed(3)}mm`, `${c.at.y.toFixed(3)}mm`, c.side === 'bottom' ? 'Bottom' : 'Top', (((c.rotation % 360) + 360) % 360).toFixed(1)].map(csv).join(',')),
  ].join('\n') + '\n'

  return files
}
