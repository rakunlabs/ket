import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import './setup'

async function run(doc: Doc, k: Kernel, cmd: string, args: unknown): Promise<Doc> {
  const def = command(cmd)!
  let a = parseArgs(def, args)
  if (def.prepare) a = await def.prepare({ doc, kernel: localKernel(k, doc) }, a as never)
  return applyOp(doc, { cmd, args: a }).doc
}

async function query(doc: Doc, k: Kernel, cmd: string, args: unknown = {}): Promise<any> {
  const def = command(cmd)!
  return def.run!({ doc, kernel: localKernel(k, doc) }, parseArgs(def, args) as never)
}

/** Two 2-pin headers (pins 2.54 apart along y after rotation) joined by a pair: D+ on pin 1, D− on pin 2. */
async function pairBoard(k: Kernel, opts: { gap: number; extra?: number; width?: number }) {
  let doc = emptyDoc()
  doc = await run(doc, k, 'set_board', { outline: { rect: { w: 40, h: 20 } } })
  doc = await run(doc, k, 'add_component', { footprint_name: 'pinrow2', ref: 'J1', at: [-15, 0], rotation: 90 })
  doc = await run(doc, k, 'add_component', { footprint_name: 'pinrow2', ref: 'J2', at: [15, 0], rotation: 90 })
  doc = await run(doc, k, 'connect', { nets: [{ name: 'DP', pins: ['J1.1', 'J2.1'] }, { name: 'DN', pins: ['J1.2', 'J2.2'] }] })
  k.build(doc)
  const b = k.boardState(doc)!.board
  const pin = (ref: string, n: string) => b.pads.find((p) => p.ref === ref && p.pin === n)!.center
  const [a1, a2, c1, c2] = [pin('J1', '1'), pin('J1', '2'), pin('J2', '1'), pin('J2', '2')]
  const mid = (a1.y + a2.y) / 2
  const w = opts.width ?? 0.2
  const half = (opts.gap + w) / 2
  const yP = mid + Math.sign(a1.y - mid) * half
  const yN = mid - Math.sign(a1.y - mid) * half
  // Out of the pins, together across the board at the gap, into the pins.
  doc = await run(doc, k, 'add_track', { net: 'DP', layer: 'F.Cu', width: w, points: [[a1.x, a1.y], [-12, yP], [12, yP], [c1.x, c1.y]] })
  const e = opts.extra ?? 0
  // DN's detour bulges away from DP (outwards), adding e mm.
  const out = Math.sign(yN - yP)
  doc = await run(doc, k, 'add_track', { net: 'DN', layer: 'F.Cu', width: w, points: e ? [[a2.x, a2.y], [-12, yN], [-6, yN], [-6, yN + (out * e) / 2], [-4, yN + (out * e) / 2], [-4, yN], [12, yN], [c2.x, c2.y]] : [[a2.x, a2.y], [-12, yN], [12, yN], [c2.x, c2.y]] })
  return doc
}

describe('differential pairs and lengths', () => {
  it('reports lengths, skew, gap and coupling of a clean pair', async () => {
    const k = new Kernel()
    let doc = await pairBoard(k, { gap: 0.15 })
    doc = await run(doc, k, 'set_diff_pair', { name: 'usb', p: 'DP', n: 'DN', width: 0.2, gap: 0.15, impedance: 90 })
    expect(doc.pcb!.nets.every((n) => n.class === 'pair_usb')).toBe(true)
    k.build(doc)
    const r = await query(doc, k, 'get_net_lengths')
    expect(r.pairs[0].skew).toBeLessThan(0.05)
    expect(r.pairs[0].gap.min).toBeCloseTo(0.15, 3)
    // The pad escapes (pins 2.54 mm apart) are the uncoupled part.
    expect(r.pairs[0].coupled).toBeGreaterThan(0.75)
    const drc = await query(doc, k, 'run_drc')
    expect(drc.violations.filter((v: any) => v.rule.startsWith('diff'))).toEqual([])
  }, 60_000)

  it('flags skew, a wrong gap and a wrong width', async () => {
    const k = new Kernel()
    let doc = await pairBoard(k, { gap: 0.3, extra: 2 })
    doc = await run(doc, k, 'set_diff_pair', { name: 'usb', p: 'DP', n: 'DN', width: 0.25, gap: 0.15 })
    k.build(doc)
    const rules = (await query(doc, k, 'run_drc')).violations.map((v: any) => v.rule)
    expect(rules).toContain('diff_skew')
    expect(rules).toContain('diff_gap')
    expect(rules).toContain('diff_width')
    const r = await query(doc, k, 'get_net_lengths')
    // The DN detour adds 2 × 1 mm.
    expect(r.pairs[0].skew).toBeCloseTo(2, 1)
  }, 60_000)

  it('length groups report the spread and DRC the nets outside it', async () => {
    const k = new Kernel()
    let doc = await pairBoard(k, { gap: 0.3, extra: 2 })
    doc = await run(doc, k, 'set_length_group', { name: 'bus', nets: ['DP', 'DN'], tolerance: 0.5, max: 30 })
    k.build(doc)
    const r = await query(doc, k, 'get_net_lengths')
    expect(r.groups[0].spread).toBeCloseTo(2, 1)
    const v = (await query(doc, k, 'run_drc')).violations.filter((x: any) => x.rule.startsWith('length'))
    expect(v.map((x: any) => x.rule).sort()).toEqual(['length_match', 'length_max', 'length_max'])
  }, 60_000)

  it('vias count their depth through the stackup', async () => {
    const k = new Kernel()
    let doc = await run(emptyDoc(), k, 'set_board', { outline: { rect: { w: 30, h: 20 } } })
    doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R1', at: [-8, 0] })
    doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R2', at: [8, 0] })
    doc = await run(doc, k, 'connect', { nets: [{ name: 'A', pins: ['R1.2', 'R2.1'] }] })
    doc = await run(doc, k, 'set_stackup', { preset: 'jlcpcb-2l-1.6' })
    doc = await run(doc, k, 'add_track', { net: 'A', layer: 'F.Cu', points: [[-7.175, 0], [0, 0]] })
    doc = await run(doc, k, 'add_via', { net: 'A', at: [0, 0] })
    doc = await run(doc, k, 'add_track', { net: 'A', layer: 'B.Cu', points: [[0, 0], [7.175, 0]] })
    k.build(doc)
    const [a] = (await query(doc, k, 'get_net_lengths', { nets: ['A'] })).nets
    expect(a.tracks).toBeCloseTo(14.35, 3)
    expect(a.length).toBeCloseTo(14.35 + 1.51 + 0.035, 3)
  }, 60_000)

  it('tune_length adds a meander that matches the pair and keeps DRC clean', async () => {
    const k = new Kernel()
    let doc = await pairBoard(k, { gap: 0.15, extra: 1 })
    doc = await run(doc, k, 'set_diff_pair', { name: 'usb', p: 'DP', n: 'DN', width: 0.2, gap: 0.15, skew: 0.1 })
    k.build(doc)
    const before = await query(doc, k, 'get_net_lengths')
    expect(before.pairs[0].skew).toBeCloseTo(1, 1)
    // DP is the shorter one: tune it to the pair; the meander finds the free side (away from DN).
    doc = await run(doc, k, 'tune_length', { net: 'DP', match: 'usb', amplitude: 0.3, spacing: 0.6 })
    k.build(doc)
    const after = await query(doc, k, 'get_net_lengths')
    expect(after.pairs[0].skew).toBeLessThan(0.01)
    const drc = await query(doc, k, 'run_drc')
    expect(drc.violations.filter((v: any) => ['clearance', 'short', 'diff_skew'].includes(v.rule))).toEqual([])
    await expect(run(doc, k, 'tune_length', { net: 'DP', target: 100, spacing: 0.2 })).rejects.toThrow(/too tight/)
  }, 60_000)

  it('autoroute routes a declared pair together', async () => {
    const k = new Kernel()
    let doc = emptyDoc()
    doc = await run(doc, k, 'set_board', { outline: { rect: { w: 40, h: 20 } } })
    doc = await run(doc, k, 'add_component', { footprint_name: 'pinrow2', ref: 'J1', at: [-15, 0], rotation: 90 })
    doc = await run(doc, k, 'add_component', { footprint_name: 'pinrow2', ref: 'J2', at: [15, 3], rotation: 90 })
    doc = await run(doc, k, 'connect', { nets: [{ name: 'DP', pins: ['J1.1', 'J2.1'] }, { name: 'DN', pins: ['J1.2', 'J2.2'] }] })
    doc = await run(doc, k, 'set_diff_pair', { name: 'usb', p: 'DP', n: 'DN', width: 0.2, gap: 0.2 })
    k.build(doc)
    doc = await run(doc, k, 'autoroute', { timeout: 60 })
    k.build(doc)
    const r = await query(doc, k, 'get_net_lengths')
    expect(r.pairs[0].coupled).toBeGreaterThan(0.6)
    expect(r.pairs[0].gap.min).toBeGreaterThan(0.19)
    const drc = await query(doc, k, 'run_drc')
    expect(drc.violations.filter((v: any) => ['clearance', 'short', 'diff_gap', 'diff_skew'].includes(v.rule))).toEqual([])
    expect(r.pairs[0].skew).toBeLessThanOrEqual(0.15)
    expect((await query(doc, k, 'get_board')).routing.routed).toBe('2/2 nets')
  }, 120_000)

  it('a pair that cannot run coupled is still routed, as two nets', async () => {
    const k = new Kernel()
    let doc = emptyDoc()
    doc = await run(doc, k, 'set_board', { outline: { rect: { w: 40, h: 20 } } })
    for (const [ref, at] of [['R1', [-12, 2]], ['R2', [12, 2]], ['R3', [-12, -2]], ['R4', [12, -2]]] as const) doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref, at: [...at] })
    doc = await run(doc, k, 'connect', { nets: [{ name: 'DP', pins: ['R1.2', 'R2.1'] }, { name: 'DN', pins: ['R3.2', 'R4.1'] }] })
    doc = await run(doc, k, 'set_diff_pair', { name: 'usb', p: 'DP', n: 'DN', width: 0.2, gap: 0.2 })
    // No tracks on the top layer across the middle: both nets must change layer, which a coupled run does not do.
    doc = await run(doc, k, 'add_keepout', { name: 'wall', rect: { at: [0, 0], w: 4, h: 30 }, layers: ['F.Cu'], forbid: ['tracks'] })
    k.build(doc)
    expect((await k.autoroute(doc, { timeout: 60 })).violations.join(' ')).toMatch(/usb routed as two separate nets: DP changes layer/)
    doc = await run(doc, k, 'autoroute', { timeout: 60 })
    k.build(doc)
    expect((await query(doc, k, 'get_board')).routing.routed).toBe('2/2 nets')
    expect(doc.pcb!.vias.length).toBeGreaterThanOrEqual(4)
    const drc = await query(doc, k, 'run_drc')
    expect(drc.violations.filter((v: any) => ['clearance', 'short', 'keepout'].includes(v.rule))).toEqual([])
  }, 120_000)

  it('follow renames and drop with their nets', async () => {
    const k = new Kernel()
    let doc = await pairBoard(k, { gap: 0.15 })
    doc = await run(doc, k, 'set_diff_pair', { name: 'usb', p: 'DP', n: 'DN', width: 0.2, gap: 0.15 })
    doc = await run(doc, k, 'set_length_group', { name: 'bus', nets: ['DP', 'DN'], tolerance: 1 })
    doc = await run(doc, k, 'rename_net', { from: 'DP', to: 'USB_DP' })
    expect(doc.pcb!.diff_pairs![0].p).toBe('USB_DP')
    expect(doc.pcb!.length_groups![0].nets).toEqual(['USB_DP', 'DN'])
    doc = await run(doc, k, 'disconnect', { nets: ['DN'] })
    expect(doc.pcb!.diff_pairs).toBeUndefined()
    expect(doc.pcb!.length_groups).toBeUndefined()
    await expect(run(doc, k, 'set_diff_pair', { name: 'x', p: 'USB_DP', n: 'NOPE', width: 0.2, gap: 0.15 })).rejects.toThrow(/no net "NOPE"/)
  }, 60_000)
})
