// Helpers shared by the PCB commands: document access, parts by ref, pins by name, net tidying.

import type { Component, Doc, Pcb } from '../doc'
import { normalizeDoc } from '../doc'

export function clone(doc: Doc): Doc {
  return normalizeDoc(JSON.parse(JSON.stringify(doc)) as Doc)
}

export function pcbOf(doc: Doc): Pcb {
  if (!doc.pcb) throw new Error('the project has no board yet; start with set_board')
  return doc.pcb
}

export const refRe = /^[A-Z]+[0-9]+$/

export function comp(pcb: Pcb, ref: string): Component {
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

export function nextRef(pcb: Pcb, prefix: string) {
  let n = 1
  while (pcb.components.some((c) => c.ref === `${prefix}${n}`)) n++
  return `${prefix}${n}`
}

export const AUTO_NET = /^N\d+$/

/** Drops empty nets and the wires whose pins are no longer on one net. */
export function tidy(pcb: Pcb) {
  pcb.nets = pcb.nets.filter((n) => n.pins.length > 0)
  // Pairs and groups of nets that are gone go too.
  const nets = new Set(pcb.nets.map((n) => n.name))
  if (pcb.diff_pairs) {
    pcb.diff_pairs = pcb.diff_pairs.filter((d) => nets.has(d.p) && nets.has(d.n))
    if (!pcb.diff_pairs.length) delete pcb.diff_pairs
  }
  if (pcb.length_groups) {
    for (const g of pcb.length_groups) g.nets = g.nets.filter((x) => nets.has(x))
    pcb.length_groups = pcb.length_groups.filter((g) => g.nets.length >= 2)
    if (!pcb.length_groups.length) delete pcb.length_groups
  }
  if (!pcb.wires) return
  const netOf = new Map<string, string>()
  for (const n of pcb.nets) for (const p of n.pins) netOf.set(p, n.name)
  pcb.wires = pcb.wires.filter((w) => netOf.has(w.a) && netOf.get(w.a) === netOf.get(w.b))
  if (!pcb.wires.length) delete pcb.wires
}
