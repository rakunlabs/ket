// A KiCad board file (.kicad_pcb, format 20240108 = KiCad 8, which KiCad 9
// opens too) written from the resolved board: outline and cut-outs,
// footprints with their pads, silkscreen and courtyard, nets and net
// classes, tracks, vias, pours (as zones KiCad refills), keep-outs (rule
// areas), mounting holes and silkscreen text. Our own writer: no KiCad code
// is linked or translated.
//
// Coordinates: Ket is y-up with angles counter-clockwise (as Gerber);
// KiCad's PCB is y-down, and its angles are counter-clockwise on screen,
// which in y-down numbers is the same sign. So y flips and angles keep
// their sign, measured on the flipped picture.

import type { Doc, Pcb } from '../doc'
import type { ResolvedBoard } from './board'
import { DEFAULT_CLASS, copperLayers } from './board'
import { type Poly, toWorld } from './geometry'

const n = (v: number) => String(Math.round(v * 1e6) / 1e6 + 0)
const X = (x: number) => n(x)
const Y = (y: number) => n(-y)
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** A UUID derived from a string, so the same board writes the same file. */
function uuid(seed: string): string {
  // FNV-1a over the seed, four rounds with different salts → 128 bits.
  const h = (salt: number) => {
    let x = 0x811c9dc5 ^ salt
    for (let i = 0; i < seed.length; i++) {
      x ^= seed.charCodeAt(i)
      x = Math.imul(x, 0x01000193) >>> 0
    }
    return x.toString(16).padStart(8, '0')
  }
  const s = h(1) + h(2) + h(3) + h(4)
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`
}

export interface KicadExport {
  text: string
  /** What KiCad will not get exactly as in Ket. */
  notes: string[]
  counts: Record<string, number>
}

export function writeKicadPcb(doc: Doc, b: ResolvedBoard): KicadExport {
  const pcb = doc.pcb as Pcb
  const out: string[] = []
  const notes: string[] = []
  const layers = copperLayers(b.layers)
  const netNames = ['', ...pcb.nets.map((x) => x.name)]
  const netNo = new Map(netNames.map((name, i) => [name, i]))
  // Pads carry the net number and name; tracks, vias and zones only the number.
  const net = (name?: string) => (name && netNo.has(name) ? `(net ${netNo.get(name)} ${q(name)})` : '')
  const netId = (name?: string) => `(net ${name && netNo.has(name) ? netNo.get(name) : 0})`

  out.push('(kicad_pcb (version 20240108) (generator "ket") (generator_version "1")')
  out.push(`  (general (thickness ${n(b.thickness)}) (legacy_teardrops no))`)
  out.push('  (paper "A4")')
  out.push('  (layers')
  const ids: Record<string, number> = { 'F.Cu': 0, 'In1.Cu': 1, 'In2.Cu': 2, 'B.Cu': 31 }
  for (const l of layers) out.push(`    (${ids[l]} ${q(l)} signal)`)
  for (const [id, name, kind] of [
    [32, 'B.Adhes', 'user'], [33, 'F.Adhes', 'user'], [34, 'B.Paste', 'user'], [35, 'F.Paste', 'user'],
    [36, 'B.SilkS', 'user'], [37, 'F.SilkS', 'user'], [38, 'B.Mask', 'user'], [39, 'F.Mask', 'user'],
    [44, 'Edge.Cuts', 'user'], [46, 'B.CrtYd', 'user'], [47, 'F.CrtYd', 'user'], [48, 'B.Fab', 'user'], [49, 'F.Fab', 'user'],
  ] as const)
    out.push(`    (${id} ${q(name)} ${kind})`)
  out.push('  )')
  out.push('  (setup (pad_to_mask_clearance 0.05))')

  for (const [i, name] of netNames.entries()) out.push(`  (net ${i} ${q(name)})`)

  // Footprints.
  for (const c of b.components) {
    const comp = pcb.components.find((x) => x.ref === c.ref)!
    const bottom = c.side === 'bottom'
    const F = bottom ? 'B' : 'F'
    out.push(`  (footprint ${q(`ket:${c.footprint.name || c.package || c.ref}`)} (layer ${q(`${F}.Cu`)}) (uuid ${q(uuid(`fp ${c.ref}`))})`)
    out.push(`    (at ${X(c.at.x)} ${Y(c.at.y)}${c.rotation ? ` ${n(c.rotation)}` : ''})`)
    out.push(`    (property "Reference" ${q(c.ref)} (at 0 0 0) (layer ${q(`${F}.SilkS`)}) (hide yes) (uuid ${q(uuid(`ref ${c.ref}`))}) (effects (font (size 1 1) (thickness 0.15))${bottom ? ' (justify mirror)' : ''}))`)
    out.push(`    (property "Value" ${q(c.value ?? c.mpn ?? c.lcsc ?? '')} (at 0 0 0) (layer ${q(`${F}.Fab`)}) (hide yes) (uuid ${q(uuid(`val ${c.ref}`))}) (effects (font (size 1 1) (thickness 0.15))))`)
    if (c.lcsc) out.push(`    (property "LCSC" ${q(c.lcsc)} (at 0 0 0) (layer ${q(`${F}.Fab`)}) (hide yes) (uuid ${q(uuid(`lcsc ${c.ref}`))}))`)
    if (comp.dnp) out.push('    (attr smd dnp)')
    // Footprint-local geometry. KiCad places a local point at fp.at + R(fp.angle)·local
    // in its y-down frame, with R(θ)(x, y) = (x cos θ + y sin θ, -x sin θ + y cos θ),
    // for footprints on either side (a flipped footprint stores flipped local points).
    // So every local point is the inverse of that applied to Ket's world point:
    // what KiCad computes lands exactly where Ket has it, on both sides.
    const th0 = (c.rotation * Math.PI) / 180
    const [cs, sn] = [Math.cos(th0), Math.sin(th0)]
    const local = (p: { x: number; y: number }) => {
      const w = toWorld(c, p)
      const dx = w.x - c.at.x
      const dy = -(w.y - c.at.y)
      return `${n(dx * cs - dy * sn)} ${n(dx * sn + dy * cs)}`
    }
    for (const [x1, y1, x2, y2, w] of c.footprint.silk) out.push(`    (fp_line (start ${local({ x: x1, y: y1 })}) (end ${local({ x: x2, y: y2 })}) (stroke (width ${n(w || 0.12)}) (type solid)) (layer ${q(`${F}.SilkS`)}))`)
    const cy = c.footprint.courtyard
    for (let i = 0; i < cy.length; i++) out.push(`    (fp_line (start ${local(cy[i])}) (end ${local(cy[(i + 1) % cy.length])}) (stroke (width 0.05) (type solid)) (layer ${q(`${F}.CrtYd`)}))`)
    for (const pad of c.footprint.pads) {
      const th = pad.layer === 'through'
      const npth = th && pad.drill && !pad.drill.plated
      const type = npth ? 'np_thru_hole' : th ? 'thru_hole' : 'smd'
      const shape = pad.shape === 'polygon' ? 'custom' : pad.shape === 'circle' ? 'circle' : pad.shape === 'oval' ? 'oval' : 'roundrect'
      const padLayers = th ? '"*.Cu" "*.Mask"' : `${q(`${F}.Cu`)} ${q(`${F}.Paste`)} ${q(`${F}.Mask`)}`
      // Pad angle is absolute in KiCad (footprint rotation included); a bottom pad is mirrored, so its own turn reverses.
      const angle = bottom ? c.rotation - pad.rotation : pad.rotation + c.rotation
      let drill = ''
      if (pad.drill) {
        const slot = pad.drill.slot && pad.drill.slot > pad.drill.d ? pad.drill.slot : undefined
        drill = slot ? ` (drill oval ${n(pad.w >= pad.h ? slot : pad.drill.d)} ${n(pad.w >= pad.h ? pad.drill.d : slot)})` : ` (drill ${n(pad.drill.d)})`
      }
      const pinName = c.footprint.pins[pad.number]
      const netName = netOfPin(pcb, c.ref, pad.number)
      const extra = shape === 'roundrect' ? ' (roundrect_rratio 0)' : ''
      const custom =
        shape === 'custom'
          ? ` (options (clearance outline) (anchor circle)) (primitives (gr_poly (pts ${(pad.polygon ?? []).map((p) => `(xy ${n(bottom ? -p.x : p.x)} ${n(-p.y)})`).join(' ')}) (width 0) (fill yes)))`
          : ''
      const size = shape === 'custom' ? `(size ${n(Math.min(pad.w, pad.h) / 2 || 0.1)} ${n(Math.min(pad.w, pad.h) / 2 || 0.1)})` : `(size ${n(pad.w)} ${n(pad.h)})`
      out.push(
        `    (pad ${q(pad.number)} ${type} ${shape} (at ${local(pad.at)}${angle ? ` ${n(angle)}` : ''}) ${size}${drill} (layers ${padLayers})${extra}${netName ? ` ${net(netName)}` : ''}${pinName ? ` (pinfunction ${q(pinName)})` : ''} (uuid ${q(uuid(`pad ${c.ref}.${pad.number}`))})${custom})`,
      )
    }
    for (const [i, h] of (c.footprint.holes ?? []).entries())
      out.push(`    (pad "" np_thru_hole circle (at ${local(h.at)}) (size ${n(h.d)} ${n(h.d)}) (drill ${n(h.d)}) (layers "*.Cu" "*.Mask") (uuid ${q(uuid(`hole ${c.ref} ${i}`))}))`)
    if (c.model) notes.push(`${c.ref}: its own 3D model (${c.model.url}) is not referenced; assign one in KiCad`)
    out.push('  )')
  }

  // Board outline and cut-outs.
  const poly = (p: Poly, layer: string, width: number, seed: string, fill = false) =>
    `  (gr_poly (pts ${p.map((v) => `(xy ${X(v.x)} ${Y(v.y)})`).join(' ')}) (stroke (width ${n(width)}) (type solid)) (fill ${fill ? 'solid' : 'none'}) (layer ${q(layer)}) (uuid ${q(uuid(seed))}))`
  out.push(poly(b.outline, 'Edge.Cuts', 0.1, 'outline'))
  b.cutouts.forEach((c, i) => out.push(poly(c, 'Edge.Cuts', 0.1, `cutout ${i}`)))

  // Mounting holes: footprint-less NPTH as KiCad footprints (KiCad has no bare board holes).
  pcb.holes.forEach((_, i) => {
    const h = b.holes.filter((x) => !x.ref)[i]
    if (!h) return
    out.push(`  (footprint "ket:MountingHole" (layer "F.Cu") (uuid ${q(uuid(`mh ${i}`))}) (at ${X(h.at.x)} ${Y(h.at.y)})`)
    out.push(`    (property "Reference" ${q(`H${i + 1}`)} (at 0 0 0) (layer "F.SilkS") (hide yes) (uuid ${q(uuid(`mhref ${i}`))}) (effects (font (size 1 1) (thickness 0.15))))`)
    out.push(`    (pad "" np_thru_hole circle (at 0 0) (size ${n(h.d)} ${n(h.d)}) (drill ${n(h.d)}) (layers "*.Cu" "*.Mask") (uuid ${q(uuid(`mhpad ${i}`))}))`)
    out.push('  )')
  })

  // Tracks and vias.
  pcb.tracks.forEach((t, ti) => {
    for (let i = 1; i < t.points.length; i++) {
      const [a, c] = [t.points[i - 1], t.points[i]]
      out.push(`  (segment (start ${X(a[0])} ${Y(a[1])}) (end ${X(c[0])} ${Y(c[1])}) (width ${n(t.width)}) (layer ${q(t.layer)}) ${netId(t.net)} (uuid ${q(uuid(`seg ${ti} ${i}`))}))`)
    }
  })
  pcb.vias.forEach((v, i) => out.push(`  (via (at ${X(v.at[0])} ${Y(v.at[1])}) (size ${n(v.diameter)}) (drill ${n(v.drill)}) (layers ${q(layers[0])} ${q(layers[layers.length - 1])}) ${netId(v.net)} (uuid ${q(uuid(`via ${i}`))}))`))

  // Pours as zones (KiCad refills them: press B), keep-outs as rule areas.
  const edgeRing = b.outline
  ;(pcb.zones ?? []).forEach((z, i) => {
    const ring = z.polygon?.length ? z.polygon.map(([x, y]) => ({ x, y })) : edgeRing
    const cls = b.netClass.get(z.net) ?? DEFAULT_CLASS
    const thermal = z.thermal === false ? '(connect_pads yes (clearance 0))' : `(connect_pads (clearance ${n(z.clearance ?? cls.clearance)}))`
    out.push(
      `  (zone ${netId(z.net)} (net_name ${q(z.net)}) (layer ${q(z.layer)}) (uuid ${q(uuid(`zone ${i}`))}) (hatch edge 0.5) (priority ${z.priority ?? 0}) ${thermal} (min_thickness 0.25) (filled_areas_thickness no) (fill yes (thermal_gap ${n(z.thermal ? z.thermal.gap : 0.5)}) (thermal_bridge_width ${n(z.thermal ? z.thermal.spoke : 0.5)})) (polygon (pts ${ring.map((p) => `(xy ${X(p.x)} ${Y(p.y)})`).join(' ')})))`,
    )
  })
  for (const k of b.keepouts) {
    const yes = (w: string) => (k.forbid.has(w as never) ? 'not_allowed' : 'allowed')
    const kl = k.layers.length === layers.length ? '(layers "*.Cu")' : `(layers ${k.layers.map(q).join(' ')})`
    out.push(
      `  (zone (net 0) (net_name "") ${kl} (uuid ${q(uuid(`keepout ${k.name}`))}) (name ${q(k.name)}) (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25) (keepout (tracks ${yes('tracks')}) (vias ${yes('vias')}) (pads allowed) (copperpour ${yes('pours')}) (footprints ${yes('parts')})) (polygon (pts ${k.polygon.map((p) => `(xy ${X(p.x)} ${Y(p.y)})`).join(' ')})))`,
    )
  }

  // Silkscreen artwork as filled polygons.
  let artPolys = 0
  for (const art of b.artwork ?? []) {
    const layer = art.side === 'top' ? 'F.SilkS' : 'B.SilkS'
    art.regions.forEach((reg, ri) => {
      if (reg.length > 1) notes.push(`artwork ${art.name}: ${reg.length - 1} hole(s) in a shape are drawn as separate outlines`)
      reg.forEach((ring, k) => {
        out.push(poly(ring, layer, 0, `art ${art.name} ${ri} ${k}`, k === 0))
        artPolys++
      })
    })
  }

  out.push(')')

  if (pcb.teardrops) notes.push('teardrops are not written: turn them on in KiCad (Edit → Edit Teardrops)')
  if (pcb.classes.length) notes.push(`net classes (${pcb.classes.map((c) => c.name).join(', ')}) live in the .kicad_pro file, which is not written: set them in Board Setup → Net Classes`)
  if (pcb.zones?.length) notes.push('pours are written as zone outlines: press B in KiCad to fill them')
  for (const c of b.components) if (c.footprint.pads.some((p) => p.shape === 'polygon')) notes.push(`${c.ref}: polygon pads are custom pads; check them in KiCad`)

  return {
    text: out.join('\n') + '\n',
    notes: [...new Set(notes)],
    counts: { footprints: b.components.length, nets: pcb.nets.length, tracks: pcb.tracks.reduce((s, t) => s + t.points.length - 1, 0), vias: pcb.vias.length, zones: pcb.zones?.length ?? 0, keepouts: b.keepouts.length, artwork_polygons: artPolys },
  }
}

function netOfPin(pcb: Pcb, ref: string, pin: string): string | undefined {
  const key = `${ref}.${pin}`
  return pcb.nets.find((x) => x.pins.includes(key))?.name
}

