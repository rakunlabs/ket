// PCB commands: the board, parts and their placement.

import { z } from 'zod'

import type { Component, Footprint, Pcb } from '../doc'
import { define } from '../registry'
import { expr, vec2, vec3 } from '../schema'
import { emptyPcb } from './board'
import { parsePart } from './easyeda'
import { footprintFromName } from './footprints'
import { placeParts } from './place'
import { parseOBJ, placeModel } from './model3d'
import { clone, comp, nextRef, pcbOf, refRe, tidy } from './shared'

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
    teardrops: z
      .union([z.literal(false), z.literal(true), z.object({ length: z.number().min(0.3).max(3).optional(), width: z.number().min(0.3).max(1).optional() })])
      .optional()
      .describe('Teardrops where tracks meet pads and vias (true, or { length: × pad size, default 1; width: × pad size, default 0.9 }); false removes them. They are derived from the copper, so they follow every route change; Gerber, DRC, pours and the 3D board include them'),
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
    if (a.teardrops === false) delete pcb.teardrops
    else if (a.teardrops) pcb.teardrops = a.teardrops === true ? {} : a.teardrops
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
