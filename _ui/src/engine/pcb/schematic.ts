// Schematic view derived from the netlist. Symbols come from the parts'
// EasyEDA symbols. Connections are drawn as wires where the user drew them
// (pcb.wires, between pins of one net) and as net labels on every other
// connected pin, so the drawing always shows exactly the netlist. Parts are
// placed on a grid unless a position was set with place_symbol.

import type { Component, Pcb, SymbolDef } from '../doc'

export interface SchSymbol {
  ref: string
  value: string
  x: number
  y: number
  def: SymbolDef
  /** Pin number → net name. */
  nets: Record<string, string>
  /** Pins whose net label is drawn (connected, and not fully shown by wires). */
  labels: Record<string, boolean>
}

export interface SchWire {
  a: string
  b: string
  net: string
  /** Polyline in schematic units, from pin a to pin b. */
  path: [number, number][]
  /** Whether the path came from the user's bend points. */
  routed: boolean
}

export interface Schematic {
  /** The sheet drawn, and every sheet of the design. */
  sheet: string
  sheets: string[]
  /** Net name → the other sheets it reaches (off-sheet connectors). */
  offSheet: Record<string, string[]>
  symbols: SchSymbol[]
  wires: SchWire[]
  /** Junction dots: points where three or more wire ends meet. */
  junctions: [number, number][]
  width: number
  height: number
}

const GRID = 10
const snap = (v: number) => Math.round(v / GRID) * GRID

function fallbackSymbol(c: Component): SymbolDef {
  const pads = c.footprint.pads.map((p) => p.number)
  const half = Math.ceil(pads.length / 2)
  const h = Math.max(half, 1) * 10 + 10
  return {
    rects: [[-20, -h / 2, 40, h]],
    circles: [],
    pins: pads.map((num, i) => {
      const left = i < half
      const row = left ? i : i - half
      return { number: num, name: c.footprint.pins[num] ?? num, x: left ? -30 : 30, y: -h / 2 + 10 + row * 10, dir: left ? 180 : 0, length: 10 }
    }),
  }
}

function bounds(def: SymbolDef) {
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y, w, h] of def.rects) xs.push(x, x + w), ys.push(y, y + h)
  for (const l of def.lines ?? []) for (let i = 0; i + 1 < l.length; i += 2) xs.push(l[i]), ys.push(l[i + 1])
  for (const [x, y, r] of def.circles) xs.push(x - r, x + r), ys.push(y - r, y + r)
  for (const p of def.pins) xs.push(p.x), ys.push(p.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

/** A pin end; box is its symbol's outline [minX, minY, maxX, maxY], for going around it. */
export type PinEnd = { x: number; y: number; dir: number; box?: [number, number, number, number] }

const STUB = 10

/** The point one grid step out of a pin, in the direction it points. */
function stub(p: PinEnd): [number, number] {
  const a = (p.dir * Math.PI) / 180
  return [Math.round(p.x + Math.cos(a) * STUB), Math.round(p.y - Math.sin(a) * STUB)]
}

const horizontal = (p: PinEnd) => p.dir === 0 || p.dir === 180

/**
 * An orthogonal wire from pin a to pin b through the bend points: it leaves
 * and enters each pin along the pin (never across the body), and every
 * segment is horizontal or vertical.
 */
/**
 * Extra corners so a wire that has to reach a pin from behind its symbol
 * goes around the body instead of through it.
 */
function around(p: PinEnd, toward: [number, number]): [number, number][] {
  const [sx, sy] = stub(p)
  const box = p.box ?? [p.x - 10, p.y - 10, p.x + 10, p.y + 10]
  const M = 10
  if (horizontal(p)) {
    const out = p.dir === 0 ? 1 : -1
    // Only a point really behind the pin (past the pin end, into the body side).
    if (Math.sign(toward[0] - p.x) !== -out) return []
    // toward lies behind the pin: pass above or below the body.
    const y = toward[1] <= p.y ? Math.min(box[1], toward[1]) - M : Math.max(box[3], toward[1]) + M
    const yy = snapG(toward[1] <= p.y ? Math.min(y, box[1] - M) : Math.max(y, box[3] + M))
    return [[sx, yy], [toward[0], yy]]
  }
  const out = p.dir === 90 ? -1 : 1 // y grows downward
  if (Math.sign(toward[1] - p.y) !== -out) return []
  const x = snapG(toward[0] <= p.x ? box[0] - M : box[2] + M)
  return [[x, sy], [x, toward[1]]]
}

const snapG = (v: number) => Math.round(v / 10) * 10

export function route(a: PinEnd, b: PinEnd, bends: [number, number][]): [number, number][] {
  // Straight across when the pins face each other on one line.
  if (!bends.length && ((a.y === b.y && horizontal(a) && horizontal(b)) || (a.x === b.x && !horizontal(a) && !horizontal(b)))) {
    const between = horizontal(a) ? (b.x - a.x) * Math.cos((a.dir * Math.PI) / 180) > 0 : (a.y - b.y) * Math.sin((a.dir * Math.PI) / 180) > 0
    if (between) return [[a.x, a.y], [b.x, b.y]]
  }
  const fromA = around(a, bends[0] ?? stub(b))
  const toB = around(b, bends.at(-1) ?? fromA.at(-1) ?? stub(a)).reverse()
  const pts: [number, number][] = [[a.x, a.y], stub(a), ...fromA, ...bends, ...toB, stub(b), [b.x, b.y]]
  const keep = new Set(bends.map(([x, y]) => `${x},${y}`))
  const out: [number, number][] = [pts[0]]
  const last = pts.length - 2 // index of stub(b)
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = out[out.length - 1]
    const [qx, qy] = pts[i]
    if (px !== qx && py !== qy) {
      let verticalFirst: boolean
      if (i === 2) {
        // Leave stub(a) across the pin, so the wire clears the body.
        verticalFirst = horizontal(a)
      } else if (i === last) {
        // Enter stub(b) across its pin.
        verticalFirst = !horizontal(b)
      } else {
        // Keep the previous direction unless that doubles back.
        const prev = out[out.length - 2]
        const wasVertical = prev ? prev[0] === px : !horizontal(a)
        const back = wasVertical ? Math.sign(qy - py) === -Math.sign(py - prev[1]) : Math.sign(qx - px) === -Math.sign(px - prev[0])
        verticalFirst = back ? !wasVertical : wasVertical
      }
      out.push(verticalFirst ? [px, qy] : [qx, py])
    }
    out.push([qx, qy])
  }
  // Drop zero-length and straight-through points.
  const clean: [number, number][] = []
  for (const p of out) {
    const last = clean[clean.length - 1]
    if (last && last[0] === p[0] && last[1] === p[1]) continue
    const prev = clean[clean.length - 2]
    if (prev && last) {
      // Drop a middle point only when the line goes straight on through it.
      const sameX = prev[0] === last[0] && last[0] === p[0] && Math.sign(last[1] - prev[1]) === Math.sign(p[1] - last[1])
      const sameY = prev[1] === last[1] && last[1] === p[1] && Math.sign(last[0] - prev[0]) === Math.sign(p[0] - last[0])
      // A spike (the line doubles back on itself) always goes.
      const spikeX = prev[0] === last[0] && last[0] === p[0] && Math.sign(last[1] - prev[1]) === -Math.sign(p[1] - last[1])
      const spikeY = prev[1] === last[1] && last[1] === p[1] && Math.sign(last[0] - prev[0]) === -Math.sign(p[0] - last[0])
      // Straight-through points go unless the user put them there; spikes
      // (doubling back, e.g. a bend level with a pin reached from behind) always go.
      if (((sameX || sameY) && !keep.has(`${last[0]},${last[1]}`)) || spikeX || spikeY) clean.pop()
    }
    clean.push(p)
  }
  return clean
}

export const MAIN_SHEET = 'main'

export const sheetOf = (c: Component) => c.sheet ?? MAIN_SHEET

/** The design's sheets, main first, then in order of first use. */
export function sheetsOf(pcb: Pcb): string[] {
  const out = [MAIN_SHEET]
  for (const c of pcb.components) if (!out.includes(sheetOf(c))) out.push(sheetOf(c))
  return out
}

export function schematic(pcb: Pcb, sheet = MAIN_SHEET): Schematic {
  const pinNet = new Map<string, string>()
  for (const n of pcb.nets) for (const p of n.pins) pinNet.set(p, n.name)
  const sheets = sheetsOf(pcb)
  const sheetByRef = new Map(pcb.components.map((c) => [c.ref, sheetOf(c)]))
  // Where each net goes: the sheets its pins are on.
  const offSheet: Record<string, string[]> = {}
  for (const n of pcb.nets) {
    const on = [...new Set(n.pins.map((p) => sheetByRef.get(p.slice(0, p.indexOf('.'))) ?? MAIN_SHEET))]
    if (on.includes(sheet) && on.length > 1) offSheet[n.name] = on.filter((s) => s !== sheet)
  }

  // Order: connectors first, then ICs, then passives, so signal flows
  // roughly left to right.
  const rank = (c: Component) => (/^J/.test(c.ref) ? 0 : /^U/.test(c.ref) ? 1 : 2)
  const comps = [...pcb.components].filter((c) => sheetOf(c) === sheet).sort((a, b) => rank(a) - rank(b) || a.ref.localeCompare(b.ref, undefined, { numeric: true }))

  const symbols: SchSymbol[] = []
  let cx = 0
  let cy = 0
  let rowH = 0
  const maxW = 900
  for (const c of comps) {
    const def = c.footprint.symbol ?? fallbackSymbol(c)
    const b = bounds(def)
    // Room for net labels on every side that has pins.
    const vUp = def.pins.some((p) => p.dir === 90) ? 30 : 0
    const vDown = def.pins.some((p) => p.dir === 270) ? 30 : 0
    const w = b.maxX - b.minX + 120
    const h = b.maxY - b.minY + 50 + vUp + vDown
    let x: number
    let y: number
    if (c.sch) {
      ;[x, y] = c.sch
    } else {
      if (cx + w > maxW && cx > 0) {
        cx = 0
        cy += rowH
        rowH = 0
      }
      x = snap(cx + 60 - b.minX)
      y = snap(cy + 30 + vUp - b.minY)
      cx += w
      rowH = Math.max(rowH, h)
    }
    const nets: Record<string, string> = {}
    for (const p of def.pins) {
      const n = pinNet.get(`${c.ref}.${p.number}`)
      if (n) nets[p.number] = n
    }
    symbols.push({ ref: c.ref, value: c.value ?? c.mpn ?? c.lcsc, x, y, def, nets, labels: {} })
  }

  // Wires: pin end to pin end, through the bend points or with one corner.
  const pinAt = new Map<string, PinEnd>()
  for (const s of symbols) {
    const b = bounds(s.def)
    const box: [number, number, number, number] = [s.x + b.minX, s.y + b.minY, s.x + b.maxX, s.y + b.maxY]
    for (const p of s.def.pins) pinAt.set(`${s.ref}.${p.number}`, { x: s.x + p.x, y: s.y + p.y, dir: p.dir, box })
  }
  const wires: SchWire[] = []
  const wired = new Set<string>()
  for (const w of pcb.wires ?? []) {
    const a = pinAt.get(w.a)
    const b = pinAt.get(w.b)
    const net = pinNet.get(w.a)
    if (!a || !b || !net || net !== pinNet.get(w.b)) continue
    const path = route(a, b, w.points ?? [])
    wires.push({ a: w.a, b: w.b, net, path, routed: !!w.points?.length })
    wired.add(w.a)
    wired.add(w.b)
  }

  // A net drawn completely with one connected tree of wires needs no
  // labels; otherwise every pin keeps its label (wired pins too, so pins
  // of the net far apart still read as connected).
  const complete = new Set<string>()
  for (const n of pcb.nets) {
    // A net that also lives on another sheet always keeps its labels here.
    if (offSheet[n.name]) continue
    if (!n.pins.every((p) => wired.has(p) || !pinAt.has(p))) continue
    const parent = new Map(n.pins.map((p) => [p, p]))
    const find = (p: string): string => (parent.get(p) === p ? p : find(parent.get(p)!))
    for (const w of wires) if (w.net === n.name) parent.set(find(w.a), find(w.b))
    const roots = new Set(n.pins.filter((p) => pinAt.has(p)).map(find))
    if (roots.size === 1) complete.add(n.name)
  }
  for (const s of symbols) for (const [num, net] of Object.entries(s.nets)) s.labels[num] = !complete.has(net)

  // Junctions where three or more wire ends or corners meet.
  const ends = new Map<string, number>()
  for (const w of wires) {
    for (const [x, y] of w.path) {
      const k = `${x},${y}`
      ends.set(k, (ends.get(k) ?? 0) + 1)
    }
  }
  const junctions = [...ends].filter(([, c]) => c >= 3).map(([k]) => k.split(',').map(Number) as [number, number])

  let width = 400
  let height = 300
  for (const s of symbols) {
    const b = bounds(s.def)
    width = Math.max(width, s.x + b.maxX + 80)
    height = Math.max(height, s.y + b.maxY + 40)
  }
  for (const w of wires) for (const [x, y] of w.path) (width = Math.max(width, x + 40)), (height = Math.max(height, y + 40))
  return { sheet, sheets, offSheet, symbols, wires, junctions, width, height }
}
