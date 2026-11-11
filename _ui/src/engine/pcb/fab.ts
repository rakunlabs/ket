// Fabrication outputs: Gerber X2 (RS-274X) per layer, Excellon drill,
// JLCPCB-style BOM and CPL. Regions are emitted as G36/G37 polygons, tracks
// as stroked lines with round apertures.

import type { Pcb } from '../doc'
import type { ResolvedBoard } from './board'
import type { Poly } from './geometry'
import type { ZoneFill } from './zones'
import { rot } from './geometry'

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

  region(poly: Poly) {
    if (poly.length < 3) return
    this.body.push('G36*')
    this.body.push(`X${fmt(poly[0].x)}Y${fmt(poly[0].y)}D02*`)
    for (const p of poly.slice(1)) this.body.push(`X${fmt(p.x)}Y${fmt(p.y)}D01*`)
    this.body.push(`X${fmt(poly[0].x)}Y${fmt(poly[0].y)}D01*`)
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

export function fabFiles(pcb: Pcb, b: ResolvedBoard, zones: ZoneFill[] = []): FabFiles {
  const files: FabFiles = {}
  const copper = b.layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu']
  const fn: Record<string, [string, string]> = {
    'F.Cu': ['board-F_Cu.gtl', 'Copper,L1,Top'],
    'In1.Cu': ['board-In1_Cu.g2', 'Copper,L2,Inr'],
    'In2.Cu': ['board-In2_Cu.g3', 'Copper,L3,Inr'],
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
    for (const v of pcb.vias) g.flash(v.at[0], v.at[1], v.diameter)
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
    files[file] = g.toString()
  }

  const edge = new Gerber('Profile,NP')
  for (const poly of [b.outline, ...b.cutouts]) edge.line([...poly, poly[0]].map((p) => [p.x, p.y]), 0.1)
  files['board-Edge_Cuts.gm1'] = edge.toString()

  // Excellon: plated (vias, through pads) and non-plated (holes) in one file
  // with tool comments; JLCPCB accepts both.
  const tools = new Map<string, number>()
  const hits: { t: number; x: number; y: number; plated: boolean }[] = []
  const tool = (d: number, plated: boolean) => {
    const key = `${d.toFixed(3)}${plated ? 'P' : 'N'}`
    if (!tools.has(key)) tools.set(key, tools.size + 1)
    return tools.get(key)!
  }
  for (const v of pcb.vias) hits.push({ t: tool(v.drill, true), x: v.at[0], y: v.at[1], plated: true })
  for (const p of b.pads) if (p.drill) hits.push({ t: tool(p.drill, true), x: p.center.x, y: p.center.y, plated: true })
  for (const h of b.holes) hits.push({ t: tool(h.d, false), x: h.at.x, y: h.at.y, plated: false })
  const drl = ['M48', '; ket drill file', 'FMAT,2', 'METRIC,TZ']
  for (const [key, t] of tools) drl.push(`; ${key.endsWith('P') ? 'plated' : 'non-plated'}`, `T${t}C${parseFloat(key)}`)
  drl.push('%', 'G90', 'G05')
  for (const [, t] of tools) {
    drl.push(`T${t}`)
    for (const h of hits) if (h.t === t) drl.push(`X${h.x.toFixed(3)}Y${h.y.toFixed(3)}`)
  }
  drl.push('T0', 'M30', '')
  files['board.drl'] = drl.join('\n')

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
