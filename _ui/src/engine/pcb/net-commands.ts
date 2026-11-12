// PCB commands: nets, schematic wires and net classes.

import { z } from 'zod'

import type { Net, Pcb, Wire } from '../doc'
import { define } from '../registry'
import { ident } from '../schema'
import { DEFAULT_CLASS } from './board'
import { AUTO_NET, clone, pcbOf, resolvePin, tidy } from './shared'

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
  for (const d of pcb.diff_pairs ?? []) {
    if (d.p === from) d.p = to
    if (d.n === from) d.n = to
  }
  for (const g of pcb.length_groups ?? []) g.nets = g.nets.map((x) => (x === from ? to : x))
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
