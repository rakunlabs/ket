// PCB commands: board queries, DRC, renders, fabrication files, BOM and schematic.

import { z } from 'zod'

import type { Component } from '../doc'
import { command, configKernel, define } from '../registry'
import { withConfiguration } from '../doc'
import { requireHealthyHistory } from '../operations'
import { boardStyle } from './artwork'
import { boardDrills } from './drills'
import { fabFiles } from './fab'
import { schematic } from './schematic'
import { clone, comp, pcbOf } from './shared'

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
      keepouts: pcb.keepouts?.length ? pcb.keepouts.map((k) => ({ name: k.name, forbid: k.forbid, layers: k.layers ?? 'all', points: k.polygon.length, ...(k.note ? { note: k.note } : {}) })) : undefined,
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
  args: z.object({ force: z.boolean().optional(), filename: z.string().optional(), configuration: z.string().optional().describe('Write the board of this configuration instead of the active design') }),
  async run(ctx, a) {
    requireHealthyHistory(ctx)
    if (a.configuration !== undefined && a.configuration !== ctx.doc.configuration) {
      const doc = withConfiguration(ctx.doc, a.configuration)
      try {
        return await command('export_fab')!.run!({ ...ctx, doc, kernel: configKernel(ctx, doc) }, { ...a, configuration: undefined, filename: a.filename ?? `board-fab-${a.configuration}.zip` })
      } finally {
        await ctx.kernel.build()
      }
    }
    const st = await ctx.kernel.board({ drc: true })
    if (!st) throw new Error('the project has no board yet; start with set_board')
    const problems = st.drc!.length + st.ratsnest.unrouted.length
    if (problems && !a.force) {
      throw new Error(`the board is not ready: ${st.drc!.length} DRC violation(s), ${st.ratsnest.unrouted.length} unrouted net(s). Fix them (run_drc) or pass force: true.`)
    }
    const files = fabFiles(ctx.doc.pcb!, st.board, st.zones, st.teardrops)
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
