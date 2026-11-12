// Copper pour fill. For each zone, in priority order:
//   area   = zone polygon (or the board) ∩ (board outline − edge clearance)
//   avoid  = every copper item of other nets on the layer, grown by the
//            clearance; holes and cut-outs too; earlier zones of other nets
//   fill   = area − avoid
// Same-net pads get thermal relief: a gap ring with four spokes, so they
// solder well; same-net tracks and vias join solidly. Islands that touch
// no copper of the net are dropped (they would float).

import { type LayerCount, type Pcb, type Zone, copperLayersOf, viaLayers } from '../doc'
import type { ResolvedBoard } from './board'
import { DEFAULT_CLASS } from './board'
import { teardrops } from './teardrops'

/** Unplated hole to copper, mm (JLCPCB). */
const HOLE_TO_COPPER = 0.255
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

const allCopper = (layers: number) => copperLayersOf(layers as LayerCount)

export function fillZones(pcb: Pcb, b: ResolvedBoard): ZoneFill[] {
  // Higher priority first: later zones keep clear of the earlier ones' fill, so the higher one wins (as in KiCad).
  const zones = (pcb.zones ?? []).map((z, i) => ({ z, i })).sort((a, c) => (c.z.priority ?? 0) - (a.z.priority ?? 0))
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
    // Teardrops are copper of their net: other nets' pours keep clearance from them.
    for (const d of teardrops(pcb, b)) {
      if (d.layer !== z.layer) continue
      if (d.net === z.net) same.push(d.outline)
      else avoid.push(...offset([d.outline], clearance))
    }
    for (const v of pcb.vias) {
      const c = { x: v.at[0], y: v.at[1] }
      // A blind or buried via is not on the layers outside its span (not even drilled there).
      if (!viaLayers(v, b.layers).includes(z.layer)) continue
      if (v.net === z.net) same.push(circle(c, v.diameter / 2))
      else avoid.push(circle(c, v.diameter / 2 + clearance))
    }
    // Copper keeps the fab's hole-to-copper distance from unplated holes (JLCPCB 0.25 mm), more than the net clearance.
    for (const h of b.holes) avoid.push(circle(h.at, h.d / 2 + Math.max(clearance, HOLE_TO_COPPER), 32))
    for (const c of b.cutouts) avoid.push(...offset([c], edge))
    for (const k of b.keepouts) if (k.forbid.has('pours') && k.layers.includes(z.layer)) avoid.push(k.polygon)
    for (const p of b.pads) if (p.drill && (p.net !== z.net || p.drillPlated === false)) avoid.push(...stroke(p.drillSlot ?? [p.center], p.drill + clearance * 2))
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

/**
 * Stitching vias for a net's pours: points on a grid where the net's fill is
 * on two or more layers, each with clearance to every other net's copper (the
 * fill already keeps it, so the via must lie inside the fill shrunk by its
 * radius plus the zone clearance), holes, pads and existing vias.
 */
export function stitchPoints(pcb: Pcb, b: ResolvedBoard, fills: ZoneFill[], net: string, opts: { pitch: number; diameter: number; drill: number; clearance: number; holeToHole?: number }): [number, number][] {
  const layers = [...new Set(fills.filter((f) => f.net === net).map((f) => f.layer))]
  if (layers.length < 2) return []
  // Fill shrunk by the via radius (plus a hair): a via there stays inside the copper.
  const inner = layers.map((l) => {
    const rings = fills.filter((f) => f.net === net && f.layer === l).flatMap((f) => f.regions.flat())
    return polygons(offset(unionRegions(rings), -(opts.diameter / 2 + 0.05)))
  })
  const xs = b.outline.map((p) => p.x)
  const ys = b.outline.map((p) => p.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const r = opts.diameter / 2
  const keep = r + opts.clearance
  const busy: { x: number; y: number; r: number }[] = [
    ...b.holes.map((h) => ({ x: h.at.x, y: h.at.y, r: Math.max(h.d / 2 + keep, h.d / 2 + opts.drill / 2 + (opts.holeToHole ?? 0.5) + 0.01) })),
    ...pcb.vias.map((v) => ({ x: v.at[0], y: v.at[1], r: v.diameter / 2 + (v.net === net ? opts.pitch * 0.4 : keep) })),
  ]
  const nearPad = (x: number, y: number) =>
    b.pads.some((p) => {
      const pxs = p.outline.map((q) => q.x)
      const pys = p.outline.map((q) => q.y)
      return x > Math.min(...pxs) - keep && x < Math.max(...pxs) + keep && y > Math.min(...pys) - keep && y < Math.max(...pys) + keep
    }) || b.pads.some((p) => p.drill && Math.hypot(p.center.x - x, p.center.y - y) < p.drill / 2 + opts.drill / 2 + (opts.holeToHole ?? 0.5) + 0.01)
  const out: [number, number][] = []
  const g = opts.pitch
  for (let y = Math.ceil(y0 / g) * g; y <= y1; y += g)
    for (let x = Math.ceil(x0 / g) * g; x <= x1; x += g) {
      const p = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }
      if (!inner.every((regs) => regs.some((reg) => inRegion(p, reg)))) continue
      if (busy.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < c.r)) continue
      if (nearPad(p.x, p.y)) continue
      out.push([p.x, p.y])
      busy.push({ x: p.x, y: p.y, r: g * 0.4 })
    }
  return out
}
