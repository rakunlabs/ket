// Copper pour fill. For each zone, in priority order:
//   area   = zone polygon (or the board) ∩ (board outline − edge clearance)
//   avoid  = every copper item of other nets on the layer, grown by the
//            clearance; holes and cut-outs too; earlier zones of other nets
//   fill   = area − avoid
// Same-net pads get thermal relief: a gap ring with four spokes, so they
// solder well; same-net tracks and vias join solidly. Islands that touch
// no copper of the net are dropped (they would float).

import type { Pcb, Zone } from '../doc'
import type { ResolvedBoard } from './board'
import { DEFAULT_CLASS } from './board'
import { type Ring, area, circle, difference, inRegion, intersect, offset, overlaps, polygons, stroke, union, unionRegions } from './poly'

export interface ZoneFill {
  index: number
  net: string
  layer: string
  /** Regions: [outer, ...holes]. */
  regions: Ring[][]
  area: number
  /** Islands removed because they touched no copper of the net. */
  dropped: number
}

const allCopper = (layers: number) => (layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'])

export function fillZones(pcb: Pcb, b: ResolvedBoard): ZoneFill[] {
  const zones = (pcb.zones ?? []).map((z, i) => ({ z, i })).sort((a, c) => (a.z.priority ?? 0) - (c.z.priority ?? 0))
  const fills: ZoneFill[] = []
  if (b.outline.length < 3) return fills

  for (const { z, i } of zones) {
    const cls = b.netClass.get(z.net) ?? DEFAULT_CLASS
    // 5 µm of margin keeps polygonized curves clear of the true distance.
    const clearance = Math.max(z.clearance ?? cls.clearance, 0.127) + 0.005
    const edge = z.edge ?? 0.3

    let areaRings: Ring[] = offset([b.outline], -edge)
    if (z.polygon?.length) areaRings = intersect(areaRings, [z.polygon.map(([x, y]) => ({ x, y }))])

    const avoid: Ring[] = []
    const same: Ring[] = []
    for (const p of b.pads) {
      if (!p.layers.includes(z.layer)) continue
      if (p.net === z.net) same.push(p.outline)
      else avoid.push(...offset([p.outline], clearance))
    }
    for (const t of pcb.tracks) {
      if (t.layer !== z.layer) continue
      const pts = t.points.map(([x, y]) => ({ x, y }))
      if (t.net === z.net) same.push(...stroke(pts, t.width))
      else avoid.push(...stroke(pts, t.width + 2 * clearance))
    }
    for (const v of pcb.vias) {
      const c = { x: v.at[0], y: v.at[1] }
      if (v.net === z.net) same.push(circle(c, v.diameter / 2))
      else avoid.push(circle(c, v.diameter / 2 + clearance))
    }
    for (const h of b.holes) avoid.push(circle(h.at, h.d / 2 + clearance))
    for (const c of b.cutouts) avoid.push(...offset([c], edge))
    for (const p of b.pads) if (p.drill && p.net !== z.net) avoid.push(circle(p.center, p.drill / 2 + clearance))
    const earlier: Ring[] = []
    for (const f of fills) {
      if (f.layer !== z.layer || f.net === z.net) continue
      for (const reg of f.regions) earlier.push(...offset(reg, clearance))
    }

    const otherNets = unionRegions([...union(avoid), ...(earlier.length ? unionRegions(earlier) : [])])
    // Thermal gaps are cut separately so spokes can cross them.
    const gaps: Ring[] = []
    const spokes: Ring[] = []
    const thermal = z.thermal === false ? undefined : (z.thermal ?? { gap: Math.max(clearance, 0.25), spoke: Math.max(cls.track, 0.3) })
    if (thermal) {
      for (const p of b.pads) {
        if (p.net !== z.net || !p.layers.includes(z.layer)) continue
        gaps.push(...offset([p.outline], thermal.gap))
        const xs = p.outline.map((q) => q.x)
        const ys = p.outline.map((q) => q.y)
        const rx = (Math.max(...xs) - Math.min(...xs)) / 2 + thermal.gap + 0.05
        const ry = (Math.max(...ys) - Math.min(...ys)) / 2 + thermal.gap + 0.05
        const c = p.center
        spokes.push(...stroke([{ x: c.x - rx, y: c.y }, { x: c.x + rx, y: c.y }], thermal.spoke))
        spokes.push(...stroke([{ x: c.x, y: c.y - ry }, { x: c.x, y: c.y + ry }], thermal.spoke))
      }
    }

    let fill = difference(areaRings, unionRegions([...otherNets, ...union(gaps)]))
    if (spokes.length) {
      const spokeCu = difference(intersect(union(spokes), areaRings), otherNets)
      fill = unionRegions([...fill, ...spokeCu])
    }

    // Keep islands that touch same-net copper.
    const regions = polygons(fill)
    const keep: Ring[][] = []
    let dropped = 0
    for (const reg of regions) {
      const touches = same.some((s) => overlaps(reg, [s]) || inRegion(s[0], reg))
      if (touches) keep.push(reg)
      else dropped++
    }
    fills.push({
      index: i,
      net: z.net,
      layer: z.layer,
      regions: keep,
      area: Math.round(keep.reduce((s, reg) => s + area(reg[0]) + reg.slice(1).reduce((h, r) => h + area(r), 0), 0) * 100) / 100,
      dropped,
    })
  }

  return fills
}

export { allCopper }
export type { Zone }
