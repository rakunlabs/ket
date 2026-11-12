// PCB commands. The workflow a model follows: set_board → find_parts →
// add_component (by LCSC number; the footprint is fetched once and stored
// in the op, so replay never touches the network) → connect (pins by
// name: "U1.VIN") → place → autoroute → run_drc → export_fab.

import { z } from 'zod'

import type { Component, Doc, Footprint, Net, Pcb, Track, Via, Wire } from '../doc'
import { normalizeDoc } from '../doc'
import { define } from '../registry'
import { requireHealthyHistory } from '../operations'
import { expr, ident, vec2, vec3 } from '../schema'
import { tidyTracks } from './autoroute'
import { DEFAULT_CLASS, emptyPcb } from './board'
import { boardStyle } from './artwork'
import { boardDrills } from './drills'
import { parsePart } from './easyeda'
import { footprintFromName } from './footprints'
import { placeParts } from './place'
import { parseOBJ, placeModel } from './model3d'
import { fabFiles } from './fab'
import { schematic } from './schematic'
import { fillZones, stitchPoints } from './zones'

function clone(doc: Doc): Doc {
  return normalizeDoc(JSON.parse(JSON.stringify(doc)) as Doc)
}

function pcbOf(doc: Doc): Pcb {
  if (!doc.pcb) throw new Error('the project has no board yet; start with set_board')
  return doc.pcb
}

const refRe = /^[A-Z]+[0-9]+$/

function comp(pcb: Pcb, ref: string): Component {
  const c = pcb.components.find((x) => x.ref === ref)
  if (!c) throw new Error(`no component ${ref}; components are: ${pcb.components.map((x) => x.ref).join(', ') || '(none)'}`)
  return c
}

/**
 * Resolves "U1.VIN" / "U1.3" / "J1.GND" to "U1.<pad number>". Pin names
 * that map to several pads (GND on a USB-C) expand to all of them.
 */
export function resolvePin(pcb: Pcb, spec: string): string[] {
  const i = spec.indexOf('.')
  if (i < 1) throw new Error(`"${spec}" is not a pin; write REF.PIN, e.g. "U1.3" or "U1.VIN"`)
  const ref = spec.slice(0, i)
  const pin = spec.slice(i + 1)
  const c = comp(pcb, ref)
  const pads = c.footprint.pads.map((p) => p.number)
  if (pads.includes(pin)) return [`${ref}.${pin}`]
  const byName = Object.entries(c.footprint.pins)
    .filter(([num, name]) => name.toUpperCase() === pin.toUpperCase() && pads.includes(num))
    .map(([num]) => `${ref}.${num}`)
  if (byName.length) return byName
  const names = [...new Set(pads.map((p) => (c.footprint.pins[p] && c.footprint.pins[p] !== p ? `${p}=${c.footprint.pins[p]}` : p)))]
  throw new Error(`${ref} (${c.mpn ?? c.lcsc}) has no pin "${pin}"; pins are: ${names.join(', ')}`)
}

function nextRef(pcb: Pcb, prefix: string) {
  let n = 1
  while (pcb.components.some((c) => c.ref === `${prefix}${n}`)) n++
  return `${prefix}${n}`
}

const partModel = z
  .object({
    url: z.string().url().describe('https URL of a STEP/STL file (zip: add #file); same hosts as the import command'),
    rotate: vec3.optional().describe('Degrees about X, Y, Z in footprint space (applied first)'),
    translate: vec3.optional().describe('[x, y, z] in footprint space; z up from the board face the part sits on'),
    scale: expr.optional(),
  })
  .describe('A real 3D model for the part body (replaces the courtyard block part_<ref>): e.g. kiswitch MX switch or hot-swap STEP, a dev board STEP. Placed in footprint coordinates, then follows the part (side, rotation, position). Check it with render and measure part_<ref>.')

/** Ref letter for a generic footprint name (and the value, for bare passive sizes like "0603"). */
function genericPrefix(name: string, value = ''): string {
  const s = name.toLowerCase()
  if (/^\d{4}$/.test(s) || /^(01005|0201)$/.test(s)) {
    if (/[0-9.]\s*[unp]?f$/i.test(value)) return 'C'
    if (/[0-9.]\s*[unm]?h$/i.test(value)) return 'L'
    if (/led/i.test(value)) return 'D'
    return 'R'
  }
  if (/^res/.test(s)) return 'R'
  if (/^cap|electrolytic/.test(s)) return 'C'
  if (/^led/.test(s)) return 'D'
  if (/^(diode|sod|sma|smb|smc|melf)/.test(s)) return 'D'
  if (/^(pinrow|jst|usb|rj45|fpc|headermodule|smdpinheader|breakoutheaders)/.test(s)) return 'J'
  if (/button|switch/.test(s)) return 'SW'
  if (/^(crystal|hc49)/.test(s)) return 'Y'
  if (/^(pad|smtpad|platedhole|smdpads)/.test(s)) return 'TP'
  return 'U'
}

function refPrefix(pkg: string, desc: string, mpn: string): string {
  const s = `${pkg} ${desc} ${mpn}`.toUpperCase()
  if (/RESISTOR|^R\d{4}|\bR0[0-9]{3}\b|Ω|OHM/.test(s)) return 'R'
  if (/CAPACITOR|^C\d{4}|\bC0[0-9]{3}\b|[0-9](U|N|P)F\b/.test(s)) return 'C'
  if (/INDUCTOR|\bUH\b/.test(s)) return 'L'
  if (/LED/.test(s)) return 'D'
  if (/DIODE|SOD|SMA|SMB/.test(s)) return 'D'
  if (/USB|TYPE-C|CONN|HEADER|HDR|JST|PIN/.test(s)) return 'J'
  if (/SWITCH|BUTTON|TACT/.test(s)) return 'SW'
  if (/CRYSTAL|XTAL|OSC/.test(s)) return 'Y'
  if (/MOSFET|TRANSISTOR|SOT-23-3/.test(s)) return 'Q'
  return 'U'
}

// ── Board ──────────────────────────────────────────────────────────────

define({
  name: 'set_board',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Create or change the PCB: outline (a rect, or an XY sketch whose inner loops become cut-outs), thickness, copper layers (2 or 4) and z (height of the board\'s bottom face, so an enclosure can be modelled around it). The board appears in the 3D model as body "board" and each part as "part_<REF>" (a block of its courtyard and height): use them in checks and booleans (e.g. inside part_J1 the case cavity, or a cut where J1 meets the wall).',
  args: z.object({
    outline: z
      .union([
        z.object({ rect: z.object({ w: expr, h: expr, r: expr.optional().describe('Corner radius'), center: vec2.optional() }) }),
        z.object({ sketch: z.string().describe('An XY sketch; drive it with the same parameters as the enclosure') }),
      ])
      .optional(),
    thickness: expr.optional().describe('Default 1.6'),
    layers: z.union([z.literal(2), z.literal(4)]).optional(),
    z: expr.optional().describe('Height of the bottom face, default 0'),
  }),
  examples: [{ outline: { rect: { w: 'board_w', h: 'board_d', r: 1 } }, z: 'wall + standoff_h' }],
  apply(doc, a) {
    const next = clone(doc)
    const created = !next.pcb
    const pcb = next.pcb ?? emptyPcb()
    if (a.outline) {
      if ('sketch' in a.outline && !next.sketches.some((s) => s.name === (a.outline as { sketch: string }).sketch)) {
        throw new Error(`no sketch "${a.outline.sketch}"`)
      }
      pcb.outline = a.outline as Pcb['outline']
    }
    if (a.thickness !== undefined) pcb.thickness = a.thickness
    if (a.layers) pcb.layers = a.layers
    if (a.z !== undefined) pcb.placement = { ...pcb.placement, z: a.z }
    next.pcb = pcb
    return { doc: next, summary: created ? 'created the board' : 'updated the board' }
  },
})

define({
  name: 'find_parts',
  group: 'pcb',
  kind: 'query',
  description:
    'Search the LCSC / JLCPCB parts library. The search matches part numbers and manufacturers best ("AMS1117-3.3", "TYPE-C-31-M-12", "0603WAF1002T5E"), not descriptions. Prefer basic parts (cheaper assembly) and parts in stock. Returns LCSC numbers for add_component.',
  args: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(30).optional() }),
  async run(ctx, a) {
    if (!ctx.services) throw new Error('the parts library is only available with the server')
    const hits = await ctx.services.searchParts(a.query, a.limit ?? 10)
    return { count: hits.length, parts: hits, hint: hits.length ? undefined : 'nothing found: try the manufacturer part number' }
  },
})

define({
  name: 'part_info',
  group: 'pcb',
  kind: 'query',
  description: 'Show an LCSC part before adding it: manufacturer part number, package, stock, and its pins (pad number → name) and pad positions.',
  args: z.object({ lcsc: z.string() }),
  async run(ctx, a) {
    if (!ctx.services) throw new Error('the parts library is only available with the server')
    const { footprint, info } = parsePart(await ctx.services.getPart(a.lcsc!))
    return {
      ...info,
      footprint: footprint.name,
      pins: footprint.pads.map((p) => `${p.number}${footprint.pins[p.number] && footprint.pins[p.number] !== p.number ? ` ${footprint.pins[p.number]}` : ''} @ [${p.at.x}, ${p.at.y}]`),
      size: (() => {
        const xs = footprint.courtyard.map((p) => p.x)
        const ys = footprint.courtyard.map((p) => p.y)
        return [Math.round((Math.max(...xs) - Math.min(...xs)) * 100) / 100, Math.round((Math.max(...ys) - Math.min(...ys)) * 100) / 100]
      })(),
      height: footprint.height,
    }
  },
})

const footprintSchema = z.record(z.string(), z.unknown())

define({
  name: 'add_component',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Place a part on the board: a real LCSC part by its number (from find_parts: footprint, pin names, 3D model, price), or a generic footprint by name with footprint_name when there is no LCSC entry or the exact part does not matter yet ("0603", "0805", "soic8", "sot23", "sot223", "qfn16_p0.5mm", "tssop20", "pinrow4", "pinrow6_p2mm", "dip8", "jst_ph_4", "to220", "sod123", ...; pins numbered 1, 2, ... and named with pin_names). Give one of lcsc or footprint_name; lcsc can still be given with a footprint_name for the BOM. ref is chosen automatically (U1, R3, ...) unless given. at is the part center in board coordinates [x, y] (expressions allowed), rotation in degrees CCW, side top or bottom. value is the BOM comment ("10k", "100nF").',
  args: z.object({
    lcsc: z.string().optional().describe('LCSC part number, e.g. "C6186"'),
    footprint_name: z.string().optional().describe('A generic footprint by name instead of the LCSC library, e.g. "0603", "soic8", "pinrow4"'),
    pin_names: z.record(z.string(), z.string()).optional().describe('footprint_name: names for pin numbers, e.g. {"1": "VCC", "2": "GND"}'),
    ref: z.string().regex(refRe, 'letters then a number, e.g. U1, R12, J2').optional(),
    at: vec2,
    rotation: expr.optional(),
    side: z.enum(['top', 'bottom']).optional(),
    edge: z.boolean().optional().describe('Edge connector (USB, header): its body may overhang the board edge'),
    value: z.string().optional(),
    note: z.string().optional().describe('What it does on this board'),
    height: expr.optional().describe('Override the estimated body height (mm)'),
    model: partModel.optional(),
    dnp: z.boolean().optional().describe('Do not populate: left out of the BOM and CPL (bare solder pads, test points, parts fitted by hand). Default true for pad/smtpad/testpoint footprints'),
    footprint: footprintSchema.optional().describe('(filled in automatically)'),
    info: footprintSchema.optional().describe('(filled in automatically)'),
  }),
  internal: ['footprint', 'info'],
  examples: [
    { lcsc: 'C6186', at: [0, 0], value: 'AMS1117-3.3', note: '3.3V LDO' },
    { lcsc: 'C165948', ref: 'J1', at: ['-board_w/2 + 3.5', 0], rotation: 270, edge: true, note: 'USB-C power' },
    { footprint_name: 'pinrow4', ref: 'J2', at: [10, 0], pin_names: { 1: 'VCC', 2: 'SDA', 3: 'SCL', 4: 'GND' }, note: 'I2C header' },
  ],
  async prepare(ctx, a) {
    if (a.footprint && a.info) return a
    if (a.footprint_name) {
      const footprint = await footprintFromName(a.footprint_name, a.pin_names)
      const info = { lcsc: a.lcsc ?? '', mpn: a.value ?? a.footprint_name, description: a.footprint_name, package: a.footprint_name, basic: false }
      return { ...a, footprint: footprint as unknown as Record<string, unknown>, info: info as unknown as Record<string, unknown> }
    }
    if (!a.lcsc) throw new Error('give lcsc (an LCSC part number from find_parts) or footprint_name (a generic footprint, e.g. "0603", "soic8", "pinrow4")')
    if (!ctx.services) throw new Error('adding parts needs the server (parts library)')
    const { footprint, info } = parsePart(await ctx.services.getPart(a.lcsc!))
    // The real model gives the true body height for enclosure checks.
    if (footprint.model && ctx.services.getModel) {
      try {
        const mesh = placeModel(parseOBJ(await ctx.services.getModel(footprint.model.uuid)), footprint.model)
        if (mesh.size[2] > 0) footprint.height = Math.round(mesh.size[2] * 100) / 100
      } catch {
        // keep the estimate
      }
    }
    return { ...a, footprint: footprint as unknown as Record<string, unknown>, info: info as unknown as Record<string, unknown> }
  },
  apply(doc, a) {
    if (!a.footprint || !a.info) throw new Error('add_component needs the part data; call it through Ket so the part is fetched')
    const next = clone(doc)
    const pcb = pcbOf(next)
    const info = a.info as unknown as ReturnType<typeof parsePart>['info']
    const ref = a.ref ?? nextRef(pcb, a.footprint_name ? genericPrefix(a.footprint_name, a.value) : refPrefix(info.package, info.description, info.mpn))
    if (pcb.components.some((c) => c.ref === ref)) throw new Error(`${ref} exists already; pick another ref or use move_component`)
    const c: Component = {
      ref,
      lcsc: info.lcsc || a.lcsc || '',
      ...(a.value ? { value: a.value } : {}),
      mpn: info.mpn,
      description: info.description,
      package: info.package,
      basic: info.basic,
      at: a.at,
      ...(a.rotation !== undefined ? { rotation: a.rotation } : {}),
      ...(a.side ? { side: a.side } : {}),
      ...(a.edge ? { edge: true } : {}),
      ...(a.note ? { note: a.note } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...((a.dnp ?? /^(pad|smtpad|smdpad|testpoint|platedhole)/i.test(a.footprint_name ?? '')) ? { dnp: true } : {}),
      footprint: a.footprint as unknown as Component['footprint'],
    }
    pcb.components.push(c)
    const pins = Object.entries(c.footprint.pins)
      .filter(([n, name]) => name !== n)
      .map(([n, name]) => `${n}=${name}`)
    return { doc: next, summary: `added ${ref} ${info.mpn} (${info.package})${pins.length ? `; pins ${pins.join(' ')}` : ''}` }
  },
})

define({
  name: 'refresh_parts',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Fetch the footprint, pin names and schematic symbol of placed LCSC parts again from the library (after a parser fix, or when a part showed wrong). Position, rotation, side, nets, value, notes and 3D model stay. Pads keep their numbers, so connections hold; a pad that no longer exists is reported.',
  args: z.object({
    refs: z.array(z.string()).optional().describe('Default: every LCSC part'),
    parts: z.record(z.string(), footprintSchema).optional().describe('(filled in automatically)'),
  }),
  internal: ['parts'],
  async prepare(ctx, a) {
    if (a.parts) return a
    const pcb = ctx.doc.pcb
    if (!pcb) throw new Error('no board yet')
    if (!ctx.services) throw new Error('refresh_parts needs the server (parts library)')
    const want = pcb.components.filter((c) => c.lcsc && (!a.refs || a.refs.includes(c.ref)))
    const unknown = (a.refs ?? []).filter((r) => !pcb.components.some((c) => c.ref === r))
    if (unknown.length) throw new Error(`no part ${unknown.join(', ')}`)
    const parts: Record<string, Record<string, unknown>> = {}
    const byLcsc = new Map<string, Footprint>()
    for (const c of want) {
      let fp = byLcsc.get(c.lcsc)
      if (!fp) {
        fp = parsePart(await ctx.services.getPart(c.lcsc)).footprint
        // Keep the measured height from the first add (the 3D model is not re-read).
        if (c.footprint.height !== undefined) fp.height = c.footprint.height
        byLcsc.set(c.lcsc, fp)
      }
      parts[c.ref] = fp as unknown as Record<string, unknown>
    }
    return { ...a, parts }
  },
  apply(doc, a) {
    if (!a.parts) throw new Error('refresh_parts must be called through Ket')
    const next = clone(doc)
    const pcb = pcbOf(next)
    const lost: string[] = []
    for (const [ref, fp] of Object.entries(a.parts)) {
      const c = comp(pcb, ref)
      const f = fp as unknown as Footprint
      const nums = new Set(f.pads.map((p) => p.number))
      // Old pad numbers with escapes ("1&#96;") map to the clean ones.
      for (const n of pcb.nets) n.pins = n.pins.map((pin) => (pin.startsWith(`${ref}.`) ? `${ref}.${pin.slice(ref.length + 1).replace(/&#96;/g, '`')}` : pin))
      for (const n of pcb.nets) for (const pin of n.pins) if (pin.startsWith(`${ref}.`) && !nums.has(pin.slice(ref.length + 1))) lost.push(`${pin} (${n.name})`)
      c.footprint = f
    }
    return { doc: next, summary: `refreshed ${Object.keys(a.parts).join(', ')}${lost.length ? `; these pins are no longer on the part: ${lost.join(', ')}` : ''}` }
  },
})

define({
  name: 'move_component',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Move, rotate or flip parts. Fields left out keep their value. Tracks stay where they were, so after a part changes place, rotation or side they no longer reach its pads and can short under the new ones: pass unroute: true to remove the copper of its nets, then autoroute (and stitch_vias if the board has pours).',
  args: z.object({
    moves: z
      .array(
        z.object({
          ref: z.string(),
          at: vec2.optional(),
          rotation: expr.optional(),
          side: z.enum(['top', 'bottom']).optional(),
          edge: z.boolean().optional(),
          value: z.string().optional(),
          note: z.string().optional(),
          height: expr.optional(),
          model: partModel.nullable().optional().describe('Set a real 3D model (or null to go back to the block / EasyEDA model)'),
          dnp: z.boolean().optional().describe('Do not populate (left out of the BOM and CPL)'),
        }),
      )
      .min(1),
    unroute: z.boolean().optional().describe('Remove the tracks and vias of the nets of parts that changed place (default false)'),
  }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const moved = new Set<string>()
    for (const m of a.moves) {
      const c = comp(pcb, m.ref)
      const was = JSON.stringify([c.at, c.rotation ?? 0, c.side ?? 'top'])
      if (m.at) c.at = m.at
      if (m.rotation !== undefined) c.rotation = m.rotation
      if (m.side) c.side = m.side
      if (m.edge !== undefined) c.edge = m.edge || undefined
      if (m.value !== undefined) c.value = m.value
      if (m.note !== undefined) c.note = m.note
      if (m.height !== undefined) c.height = m.height
      if (m.dnp !== undefined) {
        if (m.dnp) c.dnp = true
        else delete c.dnp
      }
      if (m.model === null) delete c.model
      else if (m.model) c.model = m.model
      if (JSON.stringify([c.at, c.rotation ?? 0, c.side ?? 'top']) !== was) moved.add(m.ref)
    }
    // Replaying older logs must give the same board, so copper is only removed when asked.
    const nets = new Set(moved.size ? pcb.nets.filter((n) => n.pins.some((pin) => moved.has(pin.slice(0, pin.indexOf('.'))))).map((n) => n.name) : [])
    const stale = pcb.tracks.filter((t) => nets.has(t.net)).length + pcb.vias.filter((v) => !v.stitch && nets.has(v.net)).length
    let note = ''
    if (stale && a.unroute) {
      pcb.tracks = pcb.tracks.filter((t) => !nets.has(t.net))
      // Stitching vias of a pour stay: stitch_vias replaces them.
      pcb.vias = pcb.vias.filter((v) => v.stitch || !nets.has(v.net))
      note = `; removed ${stale} tracks/vias of their nets (autoroute again)`
    } else if (stale) {
      note = `; ${stale} tracks/vias of ${[...nets].join(', ')} were routed to the old position: unroute these nets (or move with unroute: true) and autoroute again`
    }
    return { doc: next, summary: `moved ${a.moves.map((m) => m.ref).join(', ')}${note}` }
  },
})

define({
  name: 'auto_place',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Place parts automatically where their connections are shortest: parts go one by one (most connected first) to the free spot inside the board with no courtyard overlap that minimises their ratsnest, trying 0/90/180/270° (rotations to restrict), then improvement passes move and swap them. Edge connectors (edge: true) and parts in keep stay; with refs only those are placed. Connect nets first, put connectors and mounting holes where they must be, then auto_place, then autoroute. The result is ordinary positions: move_component to adjust. It also says the total ratsnest length before and after.',
  args: z.object({
    refs: z.array(z.string()).optional().describe('Only these parts (default all except edge connectors)'),
    keep: z.array(z.string()).optional().describe('Parts that must not move'),
    gap: z.number().min(0).max(10).optional().describe('Courtyard to courtyard, mm (default 0.5)'),
    margin: z.number().min(0).max(20).optional().describe('From the board edge, mm (default 1)'),
    rotations: z.array(z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])).optional().describe('Allowed rotations (default all four)'),
    unroute: z.boolean().optional().describe('Remove the tracks and vias of moved parts (default true; they no longer fit)'),
    result: z.record(z.string(), z.unknown()).optional().describe('(filled in automatically)'),
  }),
  internal: ['result'],
  async prepare(ctx, a) {
    if (a.result) return a
    const pcb = ctx.doc.pcb
    if (!pcb?.components.length) throw new Error('no parts to place; add_component first')
    const unknown = [...(a.refs ?? []), ...(a.keep ?? [])].filter((r) => !pcb.components.some((c) => c.ref === r))
    if (unknown.length) throw new Error(`no part ${unknown.join(', ')}; parts are ${pcb.components.map((c) => c.ref).join(', ')}`)
    const st = await ctx.kernel.board()
    if (!st) throw new Error('the project has no board yet; start with set_board')
    const r = placeParts(pcb, st.board, { refs: a.refs, keep: a.keep, gap: a.gap, margin: a.margin, rotations: a.rotations })
    return { ...a, result: r as unknown as Record<string, unknown> }
  },
  apply(doc, a) {
    if (!a.result) throw new Error('auto_place must be called through Ket')
    const next = clone(doc)
    const pcb = pcbOf(next)
    const r = a.result as unknown as ReturnType<typeof placeParts>
    const moved = new Set<string>()
    for (const p of r.placements) {
      const c = comp(pcb, p.ref)
      const same = Array.isArray(c.at) && c.at[0] === p.at[0] && c.at[1] === p.at[1] && (c.rotation ?? 0) === p.rotation
      if (same) continue
      c.at = p.at
      c.rotation = p.rotation
      moved.add(p.ref)
    }
    let cut = 0
    if (a.unroute !== false && moved.size) {
      // Copper on nets that touch a moved part no longer lines up with its pads.
      const nets = new Set(pcb.nets.filter((n) => n.pins.some((pin) => moved.has(pin.slice(0, pin.indexOf('.'))))).map((n) => n.name))
      const before = pcb.tracks.length + pcb.vias.length
      pcb.tracks = pcb.tracks.filter((t) => !nets.has(t.net))
      pcb.vias = pcb.vias.filter((v) => !nets.has(v.net))
      cut = before - pcb.tracks.length - pcb.vias.length
    }
    return { doc: next, summary: `placed ${moved.size} part(s); ratsnest ${r.before} → ${r.after} mm${cut ? `; removed ${cut} tracks/vias of their nets (autoroute again)` : ''}` }
  },
})

define({
  name: 'remove_components',
  group: 'pcb',
  kind: 'mutate',
  description: 'Remove parts; their pins leave every net.',
  args: z.object({ refs: z.array(z.string()).min(1) }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    for (const r of a.refs) comp(pcb, r)
    const drop = new Set(a.refs)
    pcb.components = pcb.components.filter((c) => !drop.has(c.ref))
    for (const n of pcb.nets) n.pins = n.pins.filter((p) => !drop.has(p.slice(0, p.indexOf('.'))))
    tidy(pcb)
    return { doc: next, summary: `removed ${a.refs.join(', ')}` }
  },
})

// ── Nets ───────────────────────────────────────────────────────────────

define({
  name: 'connect',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Connect pins into named nets. Pins are REF.PIN with the pad number or the pin name from the part ("U1.3", "U1.VIN", "J1.GND"; a name on several pads takes all of them). Existing nets with the same name are extended. A pin already on another net is moved to this one. Connect everything before placing and routing.',
  args: z.object({
    nets: z
      .array(
        z.object({
          name: z.string().regex(/^[A-Za-z0-9_+\-./]+$/, 'use letters, digits and _ + - . /, e.g. "3V3", "GND", "USB_DP"'),
          pins: z.array(z.string()).min(1),
          class: z.string().optional().describe('Net class name (set_net_class), e.g. "power"'),
        }),
      )
      .min(1),
  }),
  examples: [
    {
      nets: [
        { name: 'VBUS', pins: ['J1.VBUS', 'U1.VIN', 'C1.1'], class: 'power' },
        { name: 'GND', pins: ['J1.GND', 'U1.GND', 'C1.2', 'C2.2'], class: 'power' },
        { name: '3V3', pins: ['U1.VOUT', 'C2.1'] },
      ],
    },
  ],
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const touched: string[] = []
    for (const spec of a.nets) {
      const pins = spec.pins.flatMap((p) => resolvePin(pcb, p))
      if (spec.class && !pcb.classes.some((c) => c.name === spec.class) && spec.class !== 'default') {
        throw new Error(`no net class "${spec.class}"; create it with set_net_class`)
      }
      for (const n of pcb.nets) if (n.name !== spec.name) n.pins = n.pins.filter((p) => !pins.includes(p))
      let net = pcb.nets.find((n) => n.name === spec.name)
      if (!net) {
        net = { name: spec.name, pins: [] } as Net
        pcb.nets.push(net)
      }
      for (const p of pins) if (!net.pins.includes(p)) net.pins.push(p)
      if (spec.class) net.class = spec.class
      touched.push(`${spec.name}(${net.pins.length})`)
    }
    tidy(pcb)
    return { doc: next, summary: `nets ${touched.join(', ')}` }
  },
})

define({
  name: 'disconnect',
  group: 'pcb',
  kind: 'mutate',
  description: 'Remove pins from their nets, or delete whole nets by name.',
  args: z.object({ pins: z.array(z.string()).optional(), nets: z.array(z.string()).optional() }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const pins = (a.pins ?? []).flatMap((p) => resolvePin(pcb, p))
    for (const n of pcb.nets) n.pins = n.pins.filter((p) => !pins.includes(p))
    const drop = new Set(a.nets ?? [])
    pcb.nets = pcb.nets.filter((n) => !drop.has(n.name) && n.pins.length > 0)
    pcb.tracks = pcb.tracks.filter((t) => !drop.has(t.net))
    pcb.vias = pcb.vias.filter((v) => !drop.has(v.net))
    tidy(pcb)
    return { doc: next, summary: `disconnected ${[...pins, ...drop].join(', ')}` }
  },
})

const AUTO_NET = /^N\d+$/

/** Drops empty nets and the wires whose pins are no longer on one net. */
function tidy(pcb: Pcb) {
  pcb.nets = pcb.nets.filter((n) => n.pins.length > 0)
  if (!pcb.wires) return
  const netOf = new Map<string, string>()
  for (const n of pcb.nets) for (const p of n.pins) netOf.set(p, n.name)
  pcb.wires = pcb.wires.filter((w) => netOf.has(w.a) && netOf.get(w.a) === netOf.get(w.b))
  if (!pcb.wires.length) delete pcb.wires
}

const sameWire = (w: Wire, a: string, b: string) => (w.a === a && w.b === b) || (w.a === b && w.b === a)

/** Pins of a net grouped by the wires between them. */
function wireGroups(pcb: Pcb, net: Net): string[][] {
  const parent = new Map(net.pins.map((p) => [p, p]))
  const find = (p: string): string => {
    const q = parent.get(p)!
    if (q === p) return p
    const r = find(q)
    parent.set(p, r)
    return r
  }
  for (const w of pcb.wires ?? []) if (parent.has(w.a) && parent.has(w.b)) parent.set(find(w.a), find(w.b))
  const groups = new Map<string, string[]>()
  for (const p of net.pins) {
    const r = find(p)
    groups.set(r, [...(groups.get(r) ?? []), p])
  }
  return [...groups.values()]
}

/** Renames a net everywhere: the netlist and its copper. */
function renameNet(pcb: Pcb, from: string, to: string) {
  for (const t of pcb.tracks) if (t.net === from) t.net = to
  for (const v of pcb.vias) if (v.net === from) v.net = to
  for (const zn of pcb.zones ?? []) if (zn.net === from) zn.net = to
}

define({
  name: 'wire_pins',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Wire pins together, as drawing a wire on the schematic does. Pins on no net form a new net (named net, or N1, N2…); a pin joins the net of the others; pins on different nets merge them into one (the given name, else the first name that is not an automatic N…), and the copper of merged nets follows. Prefer connect when you know the net names.',
  args: z.object({
    pins: z.array(z.string()).min(2).describe('REF.PIN, e.g. ["U1.VOUT", "C2.1"]; drawn as a chain of wires'),
    net: z.string().regex(/^[A-Za-z0-9_+\-./]+$/).optional().describe('Name of the resulting net'),
    points: z.array(z.tuple([z.number(), z.number()])).optional().describe('Bend points of the wire (two pins only), schematic units'),
  }),
  examples: [{ pins: ['U1.VOUT', 'C2.1'] }, { pins: ['R1.2', 'D1.1'], net: 'LED_A' }],
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const pins = [...new Set(a.pins.flatMap((p) => resolvePin(pcb, p)))]
    if (pins.length < 2) throw new Error('give at least two different pins')
    const netOf = (pin: string) => pcb.nets.find((n) => n.pins.includes(pin))
    const existing = [...new Set(pins.map(netOf).filter((n): n is Net => !!n))]
    let name = a.net ?? existing.find((n) => !AUTO_NET.test(n.name))?.name ?? existing[0]?.name
    if (!name) {
      let i = 1
      while (pcb.nets.some((n) => n.name === `N${i}`)) i++
      name = `N${i}`
    }
    let target = pcb.nets.find((n) => n.name === name)
    if (!target) {
      target = { name, pins: [], ...(existing[0]?.class ? { class: existing[0].class } : {}) } as Net
      pcb.nets.push(target)
    }
    const merged: string[] = []
    for (const n of existing) {
      if (n === target) continue
      for (const p of n.pins) if (!target.pins.includes(p)) target.pins.push(p)
      n.pins = []
      if (!target.class && n.class) target.class = n.class
      renameNet(pcb, n.name, target.name)
      merged.push(n.name)
    }
    for (const p of pins) {
      for (const n of pcb.nets) if (n !== target) n.pins = n.pins.filter((x) => x !== p)
      if (!target.pins.includes(p)) target.pins.push(p)
    }
    tidy(pcb)
    if (a.points && pins.length !== 2) throw new Error('points draw one wire: give exactly two pins with them')
    const wires = (pcb.wires ??= [])
    for (let i = 0; i + 1 < pins.length; i++) {
      const [p, q] = [pins[i], pins[i + 1]]
      const old = wires.findIndex((w) => sameWire(w, p, q))
      const w: Wire = { a: p, b: q, ...(a.points?.length ? { points: a.points.map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number]) } : {}) }
      if (old >= 0) wires[old] = w
      else wires.push(w)
    }
    return { doc: next, summary: `wired ${pins.join(', ')} → ${target.name}${merged.length ? ` (merged ${merged.join(', ')})` : ''}` }
  },
})

define({
  name: 'remove_wires',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Remove schematic wires (each given by its two pins, in any order). On an automatic net (N1, N2…) this also cuts the connection: the pins split into the groups the remaining wires join, and a pin left alone leaves the net. On a named net only the drawing goes; use disconnect to cut it.',
  args: z.object({ wires: z.array(z.tuple([z.string(), z.string()])).min(1).describe('[["R1.2", "R2.1"], ...]') }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const touched = new Set<string>()
    for (const [x, y] of a.wires) {
      const [p] = resolvePin(pcb, x)
      const [q] = resolvePin(pcb, y)
      const i = (pcb.wires ?? []).findIndex((w) => sameWire(w, p, q))
      if (i < 0) throw new Error(`no wire between ${p} and ${q}; get_board lists the wires`)
      pcb.wires!.splice(i, 1)
      const n = pcb.nets.find((m) => m.pins.includes(p))
      if (n) touched.add(n.name)
    }
    const split: string[] = []
    for (const name of touched) {
      const net = pcb.nets.find((n) => n.name === name)
      if (!net || !AUTO_NET.test(name)) continue
      const groups = wireGroups(pcb, net).filter((g) => g.length > 1)
      net.pins = groups[0] ?? []
      for (const g of groups.slice(1)) {
        let i = 1
        while (pcb.nets.some((n) => n.name === `N${i}`)) i++
        pcb.nets.push({ name: `N${i}`, pins: g, ...(net.class ? { class: net.class } : {}) })
        split.push(`N${i}`)
      }
    }
    tidy(pcb)
    return { doc: next, summary: `removed ${a.wires.length} wire(s)${split.length ? `; split off ${split.join(', ')}` : ''}` }
  },
})

define({
  name: 'rename_net',
  group: 'pcb',
  kind: 'mutate',
  description: 'Rename a net (and its tracks, vias and pours). Renaming onto an existing net merges the two.',
  args: z.object({ from: z.string(), to: z.string().regex(/^[A-Za-z0-9_+\-./]+$/) }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const src = pcb.nets.find((n) => n.name === a.from)
    if (!src) throw new Error(`no net "${a.from}"; nets are: ${pcb.nets.map((n) => n.name).join(', ') || '(none)'}`)
    if (a.from === a.to) return { doc: next, summary: 'unchanged' }
    const dst = pcb.nets.find((n) => n.name === a.to)
    if (dst) {
      for (const p of src.pins) if (!dst.pins.includes(p)) dst.pins.push(p)
      pcb.nets = pcb.nets.filter((n) => n !== src)
    } else src.name = a.to
    renameNet(pcb, a.from, a.to)
    tidy(pcb)
    return { doc: next, summary: dst ? `merged ${a.from} into ${a.to}` : `renamed ${a.from} to ${a.to}` }
  },
})

define({
  name: 'set_net_class',
  group: 'pcb',
  kind: 'mutate',
  description: 'Create or change a net class: track width, clearance and via size for its nets (e.g. "power": 0.5 mm tracks). The "default" class applies to every other net.',
  args: z.object({
    name: ident,
    track: z.number().positive().optional().describe('Track width mm (default 0.25)'),
    clearance: z.number().positive().optional().describe('mm (default 0.2)'),
    via_drill: z.number().positive().optional(),
    via_diameter: z.number().positive().optional(),
  }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const old = pcb.classes.find((c) => c.name === a.name) ?? { ...DEFAULT_CLASS, name: a.name }
    const c = { ...old, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) }
    pcb.classes = [...pcb.classes.filter((x) => x.name !== a.name), c]
    return { doc: next, summary: `net class ${a.name}: track ${c.track}, clearance ${c.clearance}` }
  },
})

// ── Copper ─────────────────────────────────────────────────────────────

define({
  name: 'add_track',
  group: 'pcb',
  kind: 'mutate',
  description: 'Draw a track by hand: a polyline on one copper layer for a net. Width defaults to the net class. Usually autoroute does this; use add_track for short fixes.',
  args: z.object({
    net: z.string(),
    layer: z.enum(['F.Cu', 'B.Cu', 'In1.Cu', 'In2.Cu']).optional(),
    points: z.array(z.tuple([z.number(), z.number()])).min(2),
    width: z.number().positive().optional(),
  }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const net = pcb.nets.find((n) => n.name === a.net)
    if (!net) throw new Error(`no net "${a.net}"`)
    const cls = pcb.classes.find((c) => c.name === net.class) ?? DEFAULT_CLASS
    pcb.tracks.push({ net: a.net, layer: a.layer ?? 'F.Cu', width: a.width ?? cls.track, points: a.points })
    return { doc: next, summary: `track on ${a.net}` }
  },
})

define({
  name: 'add_via',
  group: 'pcb',
  kind: 'mutate',
  description: 'Add a via for a net at [x, y]; size defaults to the net class.',
  args: z.object({ net: z.string(), at: z.tuple([z.number(), z.number()]) }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const net = pcb.nets.find((n) => n.name === a.net)
    if (!net) throw new Error(`no net "${a.net}"`)
    const cls = pcb.classes.find((c) => c.name === net.class) ?? DEFAULT_CLASS
    pcb.vias.push({ net: a.net, at: a.at, drill: cls.via_drill, diameter: cls.via_diameter })
    return { doc: next, summary: `via on ${a.net}` }
  },
})

define({
  name: 'stitch_vias',
  group: 'pcb',
  kind: 'mutate',
  description:
    "Stitch a net's copper pours together with vias: on a grid (pitch, default 5 mm) wherever the net's fill is on two or more layers, keeping clearance to other nets, pads, holes and existing vias. Use after add_zone on F.Cu and B.Cu (usually GND), so the two pours become one ground and pads that only one layer reaches join the net. Replaces earlier stitching vias of the net. Check with get_board (routing) and run_drc.",
  args: z.object({
    net: z.string().optional().describe('Default GND'),
    pitch: z.number().min(1).max(30).optional().describe('Grid spacing, mm (default 5)'),
    points: z.array(z.tuple([z.number(), z.number()])).optional().describe('(filled in automatically)'),
  }),
  internal: ['points'],
  async prepare(ctx, a) {
    if (a.points) return a
    const pcb = ctx.doc.pcb
    const net = a.net ?? 'GND'
    if (!pcb?.nets.some((n) => n.name === net)) throw new Error(`no net "${net}"; nets are ${pcb?.nets.map((n) => n.name).join(', ') || 'none'}`)
    // Fill the pours without this net's old stitching vias.
    const st = await ctx.kernel.board()
    if (!st) throw new Error('the project has no board yet; start with set_board')
    const cls = pcb.classes.find((c) => c.name === pcb.nets.find((n) => n.name === net)!.class) ?? DEFAULT_CLASS
    const mine = pcb.vias.filter((v) => v.net === net && v.stitch)
    const rest = { ...pcb, vias: pcb.vias.filter((v) => !mine.includes(v)) }
    const fills = mine.length ? fillZones(rest, st.board) : st.zones
    const points = stitchPoints(rest, st.board, fills, net, { pitch: a.pitch ?? 5, diameter: cls.via_diameter, drill: cls.via_drill, clearance: Math.max(...pcb.classes.map((c) => c.clearance), cls.clearance) })
    if (!points.length) throw new Error(`no room for stitching vias on ${net}: it needs pours on two layers (add_zone on F.Cu and B.Cu) with free copper; try a smaller pitch`)
    return { ...a, points }
  },
  apply(doc, a) {
    if (!a.points) throw new Error('stitch_vias must be called through Ket')
    const next = clone(doc)
    const pcb = pcbOf(next)
    const net = a.net ?? 'GND'
    const n = pcb.nets.find((x) => x.name === net)
    if (!n) throw new Error(`no net "${net}"`)
    const cls = pcb.classes.find((c) => c.name === n.class) ?? DEFAULT_CLASS
    const before = pcb.vias.length
    pcb.vias = pcb.vias.filter((v) => !(v.net === net && v.stitch))
    for (const at of a.points) pcb.vias.push({ net, at, drill: cls.via_drill, diameter: cls.via_diameter, stitch: true })
    return { doc: next, summary: `${a.points.length} stitching vias on ${net}${before - (pcb.vias.length - a.points.length) ? ` (replaced ${before - (pcb.vias.length - a.points.length)})` : ''}` }
  },
})

define({
  name: 'unroute',
  group: 'pcb',
  kind: 'mutate',
  description: 'Remove tracks and vias: of the listed nets, or all of them.',
  args: z.object({ nets: z.array(z.string()).optional() }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const drop = a.nets ? new Set(a.nets) : undefined
    const before = pcb.tracks.length + pcb.vias.length
    pcb.tracks = pcb.tracks.filter((t) => drop && !drop.has(t.net))
    pcb.vias = pcb.vias.filter((v) => drop && !drop.has(v.net))
    return { doc: next, summary: `removed ${before - pcb.tracks.length - pcb.vias.length} tracks/vias` }
  },
})

define({
  name: 'add_zone',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Add a copper pour for a net on a layer, usually GND on B.Cu (and/or F.Cu). Without polygon it covers the whole board. The fill keeps clearance to other nets, ties same-net pads with thermal spokes and drops islands that reach no pad of the net. Add pours after placing parts; autoroute routes the other nets and leaves the pour net to the pour, so add GND vias next to F.Cu GND pads when pouring only on B.Cu.',
  args: z.object({
    net: z.string(),
    layer: z.enum(['F.Cu', 'B.Cu', 'In1.Cu', 'In2.Cu']),
    polygon: z.array(z.tuple([z.number(), z.number()])).min(3).optional().describe('Board coordinates; default the whole board'),
    clearance: z.number().positive().optional().describe('To other nets; default the net class clearance'),
    edge: z.number().min(0).optional().describe('To the board edge; default 0.3'),
    thermal: z.union([z.literal(false), z.object({ gap: z.number().positive(), spoke: z.number().positive() })]).optional(),
    priority: z.number().int().optional(),
  }),
  examples: [{ net: 'GND', layer: 'B.Cu' }, { net: 'GND', layer: 'F.Cu' }],
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    if (!pcb.nets.some((n) => n.name === a.net)) throw new Error(`no net "${a.net}"; nets are: ${pcb.nets.map((n) => n.name).join(', ') || '(none)'}`)
    if ((a.layer === 'In1.Cu' || a.layer === 'In2.Cu') && pcb.layers !== 4) throw new Error(`${a.layer} needs a 4-layer board (set_board layers: 4)`)
    pcb.zones = [...(pcb.zones ?? []), Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as never]
    return { doc: next, summary: `pour ${a.net} on ${a.layer}` }
  },
})

define({
  name: 'remove_mounting_holes',
  group: 'pcb',
  kind: 'mutate',
  description: 'Remove mounting holes by number (1-based, in the order get_board lists the board holes; part holes like hot-swap pins belong to their part), or all of them.',
  args: z.object({ numbers: z.array(z.number().int().positive()).optional(), all: z.boolean().optional() }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    if (!a.all && !a.numbers?.length) throw new Error('give numbers (from get_board holes) or all: true')
    const bad = (a.numbers ?? []).filter((n) => n > pcb.holes.length)
    if (bad.length) throw new Error(`no mounting hole ${bad.join(', ')}; there are ${pcb.holes.length}`)
    const before = pcb.holes.length
    pcb.holes = a.all ? [] : pcb.holes.filter((_, i) => !a.numbers!.includes(i + 1))
    return { doc: next, summary: `removed ${before - pcb.holes.length} mounting hole(s)` }
  },
})

define({
  name: 'remove_zones',
  group: 'pcb',
  kind: 'mutate',
  description: 'Remove copper pours by number (1-based, as get_board lists them), or all of a net.',
  args: z.object({ numbers: z.array(z.number().int().positive()).optional(), net: z.string().optional() }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const before = (pcb.zones ?? []).length
    pcb.zones = (pcb.zones ?? []).filter((zn, i) => !(a.numbers?.includes(i + 1) || (a.net && zn.net === a.net)))
    return { doc: next, summary: `removed ${before - pcb.zones.length} pour(s)` }
  },
})

define({
  name: 'add_mounting_hole',
  group: 'pcb',
  kind: 'mutate',
  description: 'Add non-plated mounting holes (e.g. d 2.7 for M2.5 screws). Use the same parameters as the enclosure standoffs so they line up.',
  args: z.object({ holes: z.array(z.object({ at: vec2, d: expr })).min(1) }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    pcb.holes.push(...a.holes)
    return { doc: next, summary: `added ${a.holes.length} mounting hole(s)` }
  },
})

/** Nets with copper or pads inside a box [[x0, y0], [x1, y1]]. */
function netsIn(pcb: Pcb, box: [[number, number], [number, number]], pads: { center: { x: number; y: number }; net?: string }[]): string[] {
  const [[x0, y0], [x1, y1]] = box
  const lo = [Math.min(x0, x1), Math.min(y0, y1)]
  const hi = [Math.max(x0, x1), Math.max(y0, y1)]
  const inBox = (x: number, y: number) => x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1]
  const out = new Set<string>()
  for (const t of pcb.tracks) if (t.points.some((p, i) => inBox(p[0], p[1]) || (i > 0 && inBox((p[0] + t.points[i - 1][0]) / 2, (p[1] + t.points[i - 1][1]) / 2)))) out.add(t.net)
  for (const v of pcb.vias) if (inBox(v.at[0], v.at[1])) out.add(v.net)
  for (const p of pads) if (p.net && inBox(p.center.x, p.center.y)) out.add(p.net)
  return [...out]
}

const vec2n = z.tuple([z.number(), z.number()])
const region = z
  .tuple([vec2n, vec2n])
  .describe('A box [[x0, y0], [x1, y1]] on the board, mm: the nets with copper or pads in it')

define({
  name: 'autoroute',
  group: 'pcb',
  kind: 'mutate',
  description:
    "Route the board with Ket's autorouter (runs in the browser): every net with 2+ pins. Tracks are 0/45/90° only, leave pads along their long side, keep each net class's width and clearance (power nets wide; they neck down only to reach fine-pitch pads) and use few vias; crowded nets are rerouted until they fit. Nets poured on every layer are left to the pour. Without nets/region it keeps existing copper and adds to it; with nets (or region) it reroutes just those: their old tracks and vias are replaced, everything else stays as an obstacle. Use it for \"redo this part of the board\": e.g. the user points at an area, pass region. Takes seconds. Then run_drc. If it fails or nets stay unrouted, give parts more room, move connectors to the edge or use 4 layers.",
  args: z.object({
    nets: z.array(z.string()).optional().describe('Reroute only these nets'),
    region: region.optional(),
    timeout: z.number().int().min(10).max(600).optional().describe('Seconds, default 180'),
    result: z.record(z.string(), z.unknown()).optional().describe('(filled in automatically)'),
  }),
  internal: ['result'],
  async prepare(ctx, a) {
    if (a.result) return a
    const pcb = ctx.doc.pcb
    if (!pcb) throw new Error('the project has no board yet; start with set_board')
    if (!pcb.nets.some((n) => n.pins.length >= 2)) throw new Error('nothing to route: connect pins into nets first')
    let nets = a.nets
    if (a.region) {
      const st = await ctx.kernel.board()
      const found = netsIn(pcb, a.region, st?.board.pads ?? [])
      if (!found.length) throw new Error(`no net has copper or pads in [[${a.region[0]}], [${a.region[1]}]]; get_board shows the outline (x right, y up)`)
      nets = [...new Set([...(nets ?? []), ...found])]
    }
    const unknown = (nets ?? []).filter((n) => !pcb.nets.some((x) => x.name === n))
    if (unknown.length) throw new Error(`no net ${unknown.map((n) => `"${n}"`).join(', ')}; nets are: ${pcb.nets.map((n) => n.name).join(', ')}`)
    const r = await ctx.kernel.autoroute({ timeout: a.timeout, skip: [...pourOnlyNets(pcb)], nets })
    return { ...a, nets, result: { ...(r as unknown as Record<string, unknown>), replaced: nets ?? null } }
  },
  apply(doc, a) {
    if (!a.result) throw new Error('autoroute must be called through Ket')
    const next = clone(doc)
    const pcb = pcbOf(next)
    const r = a.result as unknown as { tracks: Track[]; vias: Via[]; seconds?: number; unrouted?: string[]; violations?: string[]; replaced?: string[] | null }
    if (r.replaced?.length) {
      const drop = new Set(r.replaced)
      pcb.tracks = pcb.tracks.filter((t) => !drop.has(t.net))
      pcb.vias = pcb.vias.filter((v) => !drop.has(v.net))
    }
    pcb.tracks.push(...r.tracks)
    pcb.vias.push(...r.vias)
    const which = r.replaced?.length ? ` (rerouted ${r.replaced.join(', ')})` : ''
    const miss = r.unrouted?.length ? `; not routed: ${r.unrouted.join(', ')}` : ''
    const bad = r.violations?.length ? `; ${r.violations.length} DRC problem(s) left in the new copper (run_drc; fix by hand or move parts and route again): ${r.violations.slice(0, 3).join('; ')}` : ''
    return { doc: next, summary: `autorouted${which}: ${r.tracks.length} tracks, ${r.vias.length} vias${r.seconds !== undefined ? ` in ${r.seconds} s` : ''}${miss}${bad}` }
  },
})

define({
  name: 'tidy_tracks',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Clean up existing tracks without rerouting: straighten them (drop wiggles, stair steps and tiny back-and-forth segments, pulling each track tight while it keeps clearance to other copper and the board edge) and widen them to their net class width where it fits. Optionally set a new width first (e.g. "make GND thicker": nets ["GND"], width 0.6, or set_net_class). Limit it with nets or region; default all tracks. Connections stay as they are; run_drc after.',
  args: z.object({
    nets: z.array(z.string()).optional(),
    region: region.optional(),
    width: z.number().positive().optional().describe('New width for these nets, mm: they move to a net class of that width; where it does not fit the track is as wide as fits'),
    result: z.record(z.string(), z.unknown()).optional().describe('(filled in automatically)'),
  }),
  internal: ['result'],
  async prepare(ctx, a) {
    if (a.result) return a
    const pcb = ctx.doc.pcb
    if (!pcb?.tracks.length) throw new Error('there are no tracks to tidy; autoroute or add_track first')
    const st = await ctx.kernel.board()
    if (!st) throw new Error('the project has no board yet; start with set_board')
    let nets = a.nets
    if (a.region) nets = [...new Set([...(nets ?? []), ...netsIn(pcb, a.region, st.board.pads)])]
    const pick = (t: Track) => !nets || nets.includes(t.net)
    const mine = pcb.tracks.filter(pick)
    if (!mine.length) throw new Error(nets ? `no tracks on ${nets.join(', ')}` : 'no tracks')
    const rest = pcb.tracks.filter((t) => !pick(t))
    const board = a.width ? { ...st.board, netClass: new Map([...st.board.netClass, ...(nets ?? pcb.nets.map((n) => n.name)).map((n) => [n, { ...(st.board.netClass.get(n) ?? DEFAULT_CLASS), track: a.width! }] as const)]) } : st.board
    // Start each at the narrowest it may be, so widening decides the width.
    const start = mine.map((t) => ({ ...t, width: Math.min(t.width, (board.netClass.get(t.net) ?? DEFAULT_CLASS).track, DEFAULT_CLASS.track) }))
    const tidy = tidyTracks(start, rest, pcb.vias, pcb, board)
    return { ...a, nets, result: { tracks: tidy, nets: nets ?? null } }
  },
  apply(doc, a) {
    if (!a.result) throw new Error('tidy_tracks must be called through Ket')
    const next = clone(doc)
    const pcb = pcbOf(next)
    const r = a.result as unknown as { tracks: Track[]; nets: string[] | null }
    const pick = (t: Track) => !r.nets || r.nets.includes(t.net)
    const before = pcb.tracks.filter(pick)
    const corners = (ts: Track[]) => ts.reduce((s, t) => s + Math.max(0, t.points.length - 2), 0)
    pcb.tracks = [...pcb.tracks.filter((t) => !pick(t)), ...r.tracks]
    // A new width becomes the nets' class: one class per width, so DRC and later routes keep it.
    let cls = ''
    if (a.width) {
      cls = `w${String(a.width).replace('.', '_')}`
      const base = pcb.classes.find((c) => c.name === pcb.nets.find((n) => pick({ net: n.name } as Track))?.class) ?? DEFAULT_CLASS
      if (!pcb.classes.some((c) => c.name === cls)) pcb.classes.push({ ...base, name: cls, track: a.width })
      for (const n of pcb.nets) if (pick({ net: n.name } as Track)) n.class = cls
    }
    const thin = r.tracks.filter((t) => a.width && t.width < a.width - 1e-9).length
    return {
      doc: next,
      summary: `tidied ${r.nets ? r.nets.join(', ') : 'all tracks'}: ${corners(before)} → ${corners(r.tracks)} corners, ${before.length} → ${r.tracks.length} tracks${cls ? `; nets now in class ${cls} (${a.width} mm)${thin ? `, ${thin} piece(s) narrower where ${a.width} mm does not fit` : ''}` : ''}`,
    }
  },
})

/**
 * Nets poured on every copper layer are left to the pour: routing them
 * would only cut it up. Nets poured on one layer are still routed.
 */
function pourOnlyNets(pcb: Pcb): Set<string> {
  const layers = pcb.layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu']
  const out = new Set<string>()
  for (const n of pcb.nets) {
    const poured = new Set((pcb.zones ?? []).filter((zn) => zn.net === n.name && !zn.polygon).map((zn) => zn.layer))
    if (layers.every((l) => poured.has(l as never))) out.add(n.name)
  }
  return out
}

// ── Queries ────────────────────────────────────────────────────────────

define({
  name: 'get_board',
  group: 'pcb',
  kind: 'query',
  description:
    'Read the board: outline size, solder-mask/silkscreen colors, printed artwork, parts (ref, part, package, position, rotation, side, size), nets with their pins (and pin names), routing status and copper counts.',
  args: z.object({ detail: z.enum(['summary', 'full']).optional() }),
  async run(ctx, a) {
    const st = await ctx.kernel.board()
    if (!st) return { board: null, hint: 'no board yet: set_board creates one' }
    const pcb = ctx.doc.pcb!
    const { board, ratsnest } = st
    const xs = board.outline.map((p) => p.x)
    const ys = board.outline.map((p) => p.y)
    const r2 = (v: number) => Math.round(v * 100) / 100
    return {
      outline: { bbox: [[r2(Math.min(...xs)), r2(Math.min(...ys))], [r2(Math.max(...xs)), r2(Math.max(...ys))]], cutouts: board.cutouts.length },
      thickness: board.thickness,
      z: board.z,
      layers: board.layers,
      style: boardStyle(pcb),
      artwork: (board.artwork ?? []).map((art) => ({ name: art.name, kind: art.kind, side: art.side, at: art.at, width: art.width, rotation: pcb.artwork?.find((item) => item.name === art.name)?.rotation ?? 0, text: pcb.artwork?.find((item) => item.name === art.name)?.text, regions: art.regions.length })),
      errors: board.errors.length ? board.errors : undefined,
      components: board.components.map((c) => {
        const cx = c.courtyard.map((p) => p.x)
        const cy = c.courtyard.map((p) => p.y)
        const src = pcb.components.find((x) => x.ref === c.ref)!
        return {
          ref: c.ref,
          part: `${c.mpn ?? ''} (${c.lcsc})`,
          value: c.value,
          at: [r2(c.at.x), r2(c.at.y)],
          rotation: c.rotation,
          side: c.side,
          size: [r2(Math.max(...cx) - Math.min(...cx)), r2(Math.max(...cy) - Math.min(...cy))],
          note: src.note,
          pin_rules: src.pin_rules,
          ...(a.detail === 'full' ? { pins: Object.fromEntries(c.footprint.pads.map((p) => [p.number, c.footprint.pins[p.number] ?? p.number])) } : {}),
        }
      }),
      nets: pcb.nets.map((n) => ({
        name: n.name,
        class: n.class,
        pins: n.pins.map((p) => {
          const [ref, num] = [p.slice(0, p.indexOf('.')), p.slice(p.indexOf('.') + 1)]
          const name = pcb.components.find((c) => c.ref === ref)?.footprint.pins[num]
          return name && name !== num ? `${p}(${name})` : p
        }),
        routed: !ratsnest.unrouted.includes(n.name),
      })),
      routing: {
        routed: `${ratsnest.routed}/${ratsnest.total} nets`,
        missing: ratsnest.lines.slice(0, 40).map((l) => `${l.net}: ${l.from} → ${l.to}`),
        tracks: pcb.tracks.length,
        vias: pcb.vias.length,
      },
      holes: board.holes.map((h) => ({ at: [r2(h.at.x), r2(h.at.y)], d: h.d, ...(h.ref ? { part: h.ref } : {}) })),
      drills: boardDrills(pcb, board).map((h) => ({ id: h.id, at: [r2(h.at.x), r2(h.at.y)], diameter: h.d, plated: h.plated, ...(Math.hypot(h.to.x - h.from.x, h.to.y - h.from.y) > 1e-9 ? { slot: { from: h.from, to: h.to } } : {}) })),
      zones: st.zones.map((zf) => ({ number: zf.index + 1, net: zf.net, layer: zf.layer, area: zf.area, islands: zf.regions.length, dropped_islands: zf.dropped || undefined })),
      wires: pcb.wires?.length ? pcb.wires.map((w) => `${w.a} — ${w.b}`) : undefined,
    }
  },
})

define({
  name: 'run_drc',
  group: 'pcb',
  kind: 'query',
  description:
    "Design rule check against JLCPCB's standard capabilities: parts inside the outline and not overlapping, track width, clearance and shorts between nets, copper to edge, drills and hole spacing, printed artwork to exposed pads/edges/holes, plus unrouted nets. Each violation names the objects and the measured value. Fine artwork details still need manufacturer DFM review.",
  args: z.object({}),
  async run(ctx) {
    const st = await ctx.kernel.board({ drc: true })
    if (!st) throw new Error('the project has no board yet; start with set_board')
    const v = st.drc!
    const byRule: Record<string, number> = {}
    for (const x of v) byRule[x.rule] = (byRule[x.rule] ?? 0) + 1
    const unrouted = st.ratsnest.unrouted
    return {
      ok: v.length === 0 && unrouted.length === 0,
      summary: `${v.length} violation(s)${unrouted.length ? `, ${unrouted.length} unrouted net(s)` : ''}; routed ${st.ratsnest.routed}/${st.ratsnest.total} nets`,
      by_rule: byRule,
      violations: v.slice(0, 60),
      truncated: v.length > 60 || undefined,
      unrouted: unrouted.length ? st.ratsnest.lines.slice(0, 30).map((l) => `${l.net}: ${l.from} → ${l.to}`) : undefined,
    }
  },
})

define({
  name: 'render_board',
  group: 'pcb',
  kind: 'query',
  description: 'Draw the board from above (or below): outline, pads, tracks (top red, bottom blue), vias, refs, ratsnest lines for missing connections and red markers at DRC violations. highlight draws parts or nets in orange.',
  args: z.object({
    side: z.enum(['top', 'bottom']).optional(),
    size: z.number().int().min(256).max(1400).optional(),
    highlight: z.array(z.string()).optional().describe('Refs or net names'),
    drc: z.boolean().optional().describe('Mark DRC violations (default true)'),
  }),
  async run(ctx, a) {
    if (!ctx.renderBoard) throw new Error('render_board is only available in the browser')
    const st = await ctx.kernel.board({ drc: a.drc !== false })
    if (!st) throw new Error('the project has no board yet; start with set_board')
    const out = await ctx.renderBoard({ size: a.size ?? 800, side: a.side ?? 'top', ratsnest: true, highlight: a.highlight, violations: st.drc })
    return {
      text: `Board seen from the ${a.side ?? 'top'}; grid 1 mm, X right, Y up. ${st.ratsnest.routed}/${st.ratsnest.total} nets routed${st.drc?.length ? `; ${st.drc.length} DRC marker(s) in red` : ''}.`,
      images: out.images,
    }
  },
})

define({
  name: 'export_fab',
  group: 'pcb',
  kind: 'query',
  description:
    'Write the fabrication ZIP: Gerber X2 copper/mask/silk/outline, separate PTH and NPTH Excellon drill files (including rotated G85 slots), BOM and CPL. Refuses while DRC fails or nets are unrouted unless force is true. A history recovery failure cannot be bypassed.',
  args: z.object({ force: z.boolean().optional(), filename: z.string().optional() }),
  async run(ctx, a) {
    requireHealthyHistory(ctx)
    const st = await ctx.kernel.board({ drc: true })
    if (!st) throw new Error('the project has no board yet; start with set_board')
    const problems = st.drc!.length + st.ratsnest.unrouted.length
    if (problems && !a.force) {
      throw new Error(`the board is not ready: ${st.drc!.length} DRC violation(s), ${st.ratsnest.unrouted.length} unrouted net(s). Fix them (run_drc) or pass force: true.`)
    }
    const files = fabFiles(ctx.doc.pcb!, st.board, st.zones)
    if (!ctx.download) return { files: Object.keys(files) }
    const { zip } = await import('./zip')
    const blob = zip(files)
    const name = a.filename ?? 'board-fab.zip'
    await ctx.download(name, blob)
    return { ok: true, file: name, files: Object.keys(files), bytes: blob.size }
  },
})

/** JLCPCB assembly: setup fee per unique extended part (USD). */
const EXTENDED_FEE = 3

define({
  name: 'check_bom',
  group: 'pcb',
  kind: 'query',
  description:
    'Check the bill of materials for an order of boards: per part the quantity, LCSC stock, unit price and line cost (rounded up to LCSC minimum/step), JLCPCB basic or extended (extended parts add a $3 setup fee each), and problems: out of stock, not enough stock for the order, parts without an LCSC number. Prices are refreshed when older than a day. Use it before export_fab, and to pick cheaper or basic alternatives (find_parts).',
  args: z.object({ boards: z.number().int().min(1).max(100000).optional().describe('Number of boards to build, default 5') }),
  async run(ctx, a) {
    const pcb = pcbOf(ctx.doc)
    if (!ctx.services?.offers) throw new Error('check_bom needs the Ket server (prices come from LCSC)')
    const boards = a.boards ?? 5
    const groups = new Map<string, Component[]>()
    const noPart: string[] = []
    for (const c of pcb.components) {
      if (c.dnp) continue
      if (!c.lcsc) {
        noPart.push(c.ref)
        continue
      }
      groups.set(c.lcsc, [...(groups.get(c.lcsc) ?? []), c])
    }
    const offers = await ctx.services.offers(Object.fromEntries([...groups].map(([l, cs]) => [l, cs.length * boards])))
    const byLcsc = new Map(offers.map((o) => [o.lcsc, o]))
    const r2 = (v: number) => Math.round(v * 100) / 100
    let parts = 0
    let extended = 0
    const problems: string[] = []
    const lines = [...groups].map(([lcsc, cs]) => {
      const o = byLcsc.get(lcsc)
      const need = cs.length * boards
      const refs = cs.map((c) => c.ref).join(', ')
      if (!o || o.error) {
        problems.push(`${lcsc} (${refs}): no price data${o?.error ? `: ${o.error}` : ''}`)
        return { lcsc, refs, qty: need, error: o?.error ?? 'no data' }
      }
      const cost = o.unit !== undefined ? r2(o.unit * o.order) : undefined
      if (cost !== undefined) parts += cost
      if (!o.basic) extended++
      if (o.stock === 0) problems.push(`${lcsc} ${o.mpn ?? ''} (${refs}) is out of stock: find_parts for an alternative`)
      else if (o.stock !== undefined && o.stock < o.order) problems.push(`${lcsc} ${o.mpn ?? ''} (${refs}): only ${o.stock} in stock, ${o.order} needed`)
      if (o.unit === undefined) problems.push(`${lcsc} (${refs}): no price listed`)
      return {
        lcsc,
        mpn: o.mpn,
        refs,
        per_board: cs.length,
        qty: need,
        order: o.order !== need ? o.order : undefined,
        stock: o.stock,
        unit: o.unit,
        cost,
        type: o.basic ? 'basic' : 'extended',
      }
    })
    for (const r of noPart) problems.push(`${r} has no LCSC part number: JLCPCB cannot place it (set dnp: true with move_component if it is bare copper or fitted by hand)`)
    const fees = extended * EXTENDED_FEE
    const checked = offers.map((o) => o.checked).filter(Boolean).sort()[0]
    return {
      boards,
      lines,
      totals: {
        parts_usd: r2(parts),
        extended_parts: extended,
        extended_fees_usd: fees,
        total_usd: r2(parts + fees),
        per_board_usd: r2((parts + fees) / boards),
      },
      problems: problems.length ? problems : undefined,
      prices_checked: checked,
      note: 'Parts and JLCPCB extended-part fees only; PCB fabrication, assembly setup and shipping are extra. Basic parts have no fee.',
    }
  },
})

// ── Schematic ─────────────────────────────────────────────────────────

define({
  name: 'render_schematic',
  group: 'pcb',
  kind: 'query',
  description:
    "Draw the schematic: every part's symbol with its pin names, wires where they were drawn (wire_pins) and a net label on connected pins a wire does not fully show (pins with the same label are connected). It is generated from the netlist, so it always matches the board. Use it to review the circuit: unconnected pins have no wire and no label.",
  args: z.object({ size: z.number().int().min(400).max(2000).optional() }),
  async run(ctx, a) {
    if (!ctx.renderSchematic) throw new Error('render_schematic is only available in the browser')
    const pcb = pcbOf(ctx.doc)
    const sch = schematic(pcb)
    const out = await ctx.renderSchematic(a.size ?? 1200)
    const open = sch.symbols.flatMap((s) => s.def.pins.filter((p) => !s.nets[p.number]).map((p) => `${s.ref}.${p.number}${p.name !== p.number ? `(${p.name})` : ''}`))
    return {
      text: `${sch.symbols.length} parts, ${pcb.nets.length} nets, ${sch.wires.length} wires. Unconnected pins: ${open.length ? open.join(', ') : 'none'}.`,
      images: out.images,
    }
  },
})

define({
  name: 'place_symbol',
  group: 'pcb',
  kind: 'mutate',
  description: 'Move symbols on the schematic (grid units of 10 mil; the auto layout is used for parts without a position). Purely visual: nets do not change.',
  args: z.object({ moves: z.array(z.object({ ref: z.string(), at: z.tuple([z.number(), z.number()]).optional().describe('Omit to return to auto layout') })).min(1) }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    for (const m of a.moves) {
      const c = comp(pcb, m.ref)
      if (m.at) c.sch = [Math.round(m.at[0] / 10) * 10, Math.round(m.at[1] / 10) * 10]
      else delete c.sch
    }
    return { doc: next, summary: `placed symbols ${a.moves.map((m) => m.ref).join(', ')}` }
  },
})
