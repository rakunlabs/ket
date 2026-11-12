// PCB commands: tracks, vias, pours, mounting holes, autoroute and tidy.

import { z } from 'zod'

import { type CopperLayer, type Pcb, type Track, type Via, COPPER_LAYERS, copperLayersOf } from '../doc'
import { define } from '../registry'
import { expr, ident, vec2 } from '../schema'
import { tidyTracks } from './autoroute'
import { DEFAULT_CLASS } from './board'
import { fillZones, stitchPoints } from './zones'
import { routeLeg } from './leg'
import { clone, pcbOf } from './shared'

// ── Copper ─────────────────────────────────────────────────────────────

define({
  name: 'add_track',
  group: 'pcb',
  kind: 'mutate',
  description: 'Draw a track by hand: a polyline on one copper layer for a net. Width defaults to the net class. Usually autoroute does this; use add_track for short fixes.',
  args: z.object({
    net: z.string(),
    layer: z.enum(COPPER_LAYERS).optional(),
    points: z.array(z.tuple([z.number(), z.number()])).min(2),
    width: z.number().positive().optional(),
  }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const net = pcb.nets.find((n) => n.name === a.net)
    if (!net) throw new Error(`no net "${a.net}"`)
    if (a.layer && !copperLayersOf(pcb.layers).includes(a.layer)) throw new Error(`${a.layer} is not on a ${pcb.layers}-layer board; layers are ${copperLayersOf(pcb.layers).join(', ')}`)
    const cls = pcb.classes.find((c) => c.name === net.class) ?? DEFAULT_CLASS
    pcb.tracks.push({ net: a.net, layer: a.layer ?? 'F.Cu', width: a.width ?? cls.track, points: a.points })
    return { doc: next, summary: `track on ${a.net}` }
  },
})

define({
  name: 'add_via',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Add a via for a net at [x, y]; size defaults to the net class. A through via joins every layer; span: [from, to] makes a blind (from an outer layer) or buried (inner layers only) via on 4- and 6-layer boards. Blind and buried vias cost extra and not every fab makes them: export_manufacturing says so.',
  args: z.object({ net: z.string(), at: z.tuple([z.number(), z.number()]), span: z.tuple([z.enum(COPPER_LAYERS), z.enum(COPPER_LAYERS)]).optional() }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const net = pcb.nets.find((n) => n.name === a.net)
    if (!net) throw new Error(`no net "${a.net}"`)
    const cls = pcb.classes.find((c) => c.name === net.class) ?? DEFAULT_CLASS
    let span: [CopperLayer, CopperLayer] | undefined
    if (a.span) {
      const all = copperLayersOf(pcb.layers)
      const bad = a.span.filter((l) => !all.includes(l))
      if (bad.length) throw new Error(`span: ${bad.join(', ')} is not on a ${pcb.layers}-layer board; layers are ${all.join(', ')}`)
      if (a.span[0] === a.span[1]) throw new Error('span: a via joins two different layers')
      const [i, j] = a.span.map((l) => all.indexOf(l)).sort((x, y) => x - y)
      // A span over every layer is a through via.
      if (!(i === 0 && j === all.length - 1)) span = [all[i], all[j]]
    }
    pcb.vias.push({ net: a.net, at: a.at, drill: cls.via_drill, diameter: cls.via_diameter, ...(span ? { span } : {}) })
    return { doc: next, summary: `${span ? (span[0] === 'F.Cu' || span[1] === 'B.Cu' ? 'blind' : 'buried') : ''} via on ${a.net}${span ? ` (${span.join('–')})` : ''}`.trim() }
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
    layer: z.enum(COPPER_LAYERS),
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
    if (!copperLayersOf(pcb.layers).includes(a.layer)) throw new Error(`${a.layer} is not on a ${pcb.layers}-layer board (set_board layers: 4 or 6); layers are ${copperLayersOf(pcb.layers).join(', ')}`)
    pcb.zones = [...(pcb.zones ?? []), Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as never]
    return { doc: next, summary: `pour ${a.net} on ${a.layer}` }
  },
})

const layerEnum = z.enum(COPPER_LAYERS)

define({
  name: 'add_keepout',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Mark an area of the board where tracks, vias, pours and/or parts may not go: the antenna end of an ESP32 module (no copper on any layer under and beside it), under a crystal or a switching inductor (no pours), the area a connector body or a mounting screw head covers (no parts). Give the polygon (board coordinates) or rect: { at, w, h } (center), the layers it applies to (default all; parts follow the side: F.Cu top, B.Cu bottom), and what it forbids. autoroute routes around it, pours leave it empty, auto_place keeps parts out and run_drc reports anything inside. Replaces a keep-out with the same name.',
  args: z
    .object({
      name: ident,
      polygon: z.array(z.tuple([z.number(), z.number()])).min(3).optional(),
      rect: z.object({ at: z.tuple([z.number(), z.number()]), w: z.number().positive(), h: z.number().positive() }).optional(),
      layers: z.array(layerEnum).min(1).optional(),
      forbid: z.array(z.enum(['tracks', 'vias', 'pours', 'parts'])).min(1).default(['tracks', 'vias', 'pours']),
      note: z.string().optional(),
    })
    .refine((x) => !!x.polygon !== !!x.rect, { message: 'give polygon or rect (one of them)' }),
  examples: [{ name: 'antenna', rect: { at: [0, 22], w: 18, h: 6 }, forbid: ['tracks', 'vias', 'pours', 'parts'], note: 'ESP32-C3 antenna' }],
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const missing = a.layers?.filter((l) => !copperLayersOf(pcb.layers).includes(l)) ?? []
    if (missing.length) throw new Error(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not on a ${pcb.layers}-layer board (inner layers need set_board layers: 4 or 6)`)
    const polygon: [number, number][] = a.polygon ?? (() => {
      const [x, y] = a.rect!.at
      const [w, h] = [a.rect!.w / 2, a.rect!.h / 2]
      return [[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]]
    })()
    const k = { name: a.name, polygon, ...(a.layers ? { layers: a.layers } : {}), forbid: [...new Set(a.forbid)], ...(a.note ? { note: a.note } : {}) }
    const list = (pcb.keepouts ?? []).filter((x) => x.name !== a.name)
    const replaced = list.length !== (pcb.keepouts ?? []).length
    pcb.keepouts = [...list, k]
    return { doc: next, summary: `${replaced ? 'replaced' : 'added'} keep-out ${a.name} (no ${k.forbid.join(', ')}${a.layers ? ` on ${a.layers.join(', ')}` : ''})` }
  },
})

define({
  name: 'remove_keepouts',
  group: 'pcb',
  kind: 'mutate',
  description: 'Remove keep-out areas by name.',
  args: z.object({ names: z.array(z.string()).min(1) }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const missing = a.names.filter((n) => !pcb.keepouts?.some((k) => k.name === n))
    if (missing.length) throw new Error(`no keep-out ${missing.join(', ')}; keep-outs are: ${pcb.keepouts?.map((k) => k.name).join(', ') || '(none)'}`)
    pcb.keepouts = pcb.keepouts!.filter((k) => !a.names.includes(k.name))
    if (!pcb.keepouts.length) delete pcb.keepouts
    return { doc: next, summary: `removed keep-outs ${a.names.join(', ')}` }
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
  const layers = copperLayersOf(pcb.layers)
  const out = new Set<string>()
  for (const n of pcb.nets) {
    const poured = new Set((pcb.zones ?? []).filter((zn) => zn.net === n.name && !zn.polygon).map((zn) => zn.layer))
    if (layers.every((l) => poured.has(l as never))) out.add(n.name)
  }
  return out
}

define({
  name: 'route_leg',
  group: 'pcb',
  kind: 'query',
  description:
    'Plan one leg of a track for net on layer from a to b (board mm), around everything on the board, as the autorouter would: straight when clear, else 0/45/90° around obstacles. Returns the points (nothing is changed); commit them with add_track. The board view uses it for interactive routing: click a pad, click on, double-click to finish.',
  args: z.object({ net: z.string(), layer: z.enum(COPPER_LAYERS), a: vec2n, b: vec2n, width: z.number().positive().optional() }),
  async run(ctx, a) {
    const st = await ctx.kernel.board()
    if (!st || !ctx.doc.pcb) throw new Error('the project has no board yet; start with set_board')
    if (!ctx.doc.pcb.nets.some((n) => n.name === a.net)) throw new Error(`no net "${a.net}"`)
    if (!copperLayersOf(ctx.doc.pcb.layers).includes(a.layer)) throw new Error(`${a.layer} is not on a ${ctx.doc.pcb.layers}-layer board`)
    const r = routeLeg(ctx.doc.pcb, st.board, a.net, a.layer, a.a, a.b, a.width)
    if (!r) return { ok: false, note: `no way for ${a.net} from [${a.a}] to [${a.b}] on ${a.layer}: try another layer (a via), or a point in between` }
    return { ok: true, ...r }
  },
})
