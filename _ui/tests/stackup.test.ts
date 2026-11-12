import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { fabFiles } from '../src/engine/pcb/fab'
import { impedance, stackupThickness, STACKUP_PRESETS, widthFor } from '../src/engine/pcb/stackup'
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

describe('impedance formulas (IPC-2141)', () => {
  it('match the published closed forms', () => {
    expect(impedance({ geometry: 'microstrip', w: 0.3, t: 0.035, h: 0.2104, er: 4.4 })).toBeCloseTo(54.886, 2)
    expect(impedance({ geometry: 'stripline', w: 0.2, t: 0.035, h: 1.0, er: 4.5 })).toBeCloseTo(64.392, 2)
    // A pair is less than twice one track, more so when close.
    const single = impedance({ geometry: 'microstrip', w: 0.2, t: 0.035, h: 0.2, er: 4.4 })
    const near = impedance({ geometry: 'diff_microstrip', w: 0.2, t: 0.035, h: 0.2, er: 4.4, s: 0.1 })
    const far = impedance({ geometry: 'diff_microstrip', w: 0.2, t: 0.035, h: 0.2, er: 4.4, s: 1 })
    expect(near).toBeLessThan(far)
    expect(far).toBeLessThan(2 * single)
  })

  it('width for a target inverts the impedance', () => {
    const base = { geometry: 'microstrip' as const, t: 0.035, h: 0.2104, er: 4.4 }
    const w = widthFor(50, base)!
    expect(impedance({ ...base, w })).toBeCloseTo(50, 3)
    expect(widthFor(500, base)).toBeUndefined()
  })

  it('presets add up to their board thickness', () => {
    for (const p of Object.values(STACKUP_PRESETS)) expect(stackupThickness(p.stackup)).toBeGreaterThan(1.5)
    expect(stackupThickness(STACKUP_PRESETS['jlcpcb-4l-7628'].stackup)).toBeCloseTo(1.587, 2)
  })
})

describe('stackup and layers', () => {
  it('sets a 4-layer preset and sizes a 50 Ω track and a 90 Ω pair', async () => {
    const k = new Kernel()
    let doc = await run(emptyDoc(), k, 'set_board', { outline: { rect: { w: 30, h: 20 } }, layers: 4 })
    await expect(run(doc, k, 'set_stackup', { preset: 'jlcpcb-2l-1.6' })).rejects.toThrow(/2-layer stackup and the board has 4/)
    doc = await run(doc, k, 'set_stackup', { preset: 'jlcpcb-4l-7628' })
    expect(doc.pcb!.thickness).toBeCloseTo(1.587, 2)
    const single = await query(doc, k, 'impedance', { layer: 'F.Cu', target: 50 })
    expect(single.geometry).toBe('microstrip')
    expect(single.width).toBeGreaterThan(0.3)
    expect(single.width).toBeLessThan(0.4)
    const pair = await query(doc, k, 'impedance', { layer: 'F.Cu', target: 90, gap: 0.15 })
    expect(pair.geometry).toBe('diff_microstrip')
    expect(pair.width).toBeLessThan(single.width)
    const inner = await query(doc, k, 'impedance', { layer: 'In1.Cu', width: 0.2 })
    expect(inner.geometry).toBe('stripline')
    await expect(query(doc, k, 'impedance', { layer: 'In3.Cu', target: 50 })).rejects.toThrow(/not a layer of this board/)
  })

  it('6 layers: inner layers for tracks, pours and Gerbers', async () => {
    const k = new Kernel()
    let doc = await run(emptyDoc(), k, 'set_board', { outline: { rect: { w: 30, h: 20 } }, layers: 6 })
    doc = await run(doc, k, 'set_stackup', { preset: 'jlcpcb-6l-3313' })
    doc = await run(doc, k, 'add_component', { footprint_name: 'pinrow2', ref: 'J1', at: [-8, 0] })
    doc = await run(doc, k, 'add_component', { footprint_name: 'pinrow2', ref: 'J2', at: [8, 0] })
    doc = await run(doc, k, 'connect', { nets: [{ name: 'A', pins: ['J1.1', 'J2.1'] }, { name: 'GND', pins: ['J1.2', 'J2.2'] }] })
    doc = await run(doc, k, 'add_zone', { net: 'GND', layer: 'In4.Cu' })
    k.build(doc)
    const b = k.boardState(doc)!.board
    const p1 = b.pads.find((p) => p.ref === 'J1' && p.pin === '1')!.center
    const p2 = b.pads.find((p) => p.ref === 'J2' && p.pin === '1')!.center
    doc = await run(doc, k, 'add_track', { net: 'A', layer: 'In3.Cu', points: [[p1.x, p1.y], [p2.x, p2.y]] })
    k.build(doc)
    const st = k.boardState(doc, { drc: true })!
    expect(st.ratsnest.unrouted).not.toContain('A')
    expect(st.ratsnest.unrouted).not.toContain('GND')
    const files = fabFiles(doc.pcb!, st.board, st.zones)
    expect(Object.keys(files).filter((f) => /Cu\./.test(f)).sort()).toEqual(['board-B_Cu.gbl', 'board-F_Cu.gtl', 'board-In1_Cu.g2', 'board-In2_Cu.g3', 'board-In3_Cu.g4', 'board-In4_Cu.g5'])
    // Fewer layers while copper is on In3: refused with the way out.
    await expect(run(doc, k, 'set_board', { layers: 4 })).rejects.toThrow(/copper is on In3.Cu, In4.Cu/)
  })

  it('blind and buried vias: only on their layers, own drill files, a warning for the order', async () => {
    const k = new Kernel()
    let doc = await run(emptyDoc(), k, 'set_board', { outline: { rect: { w: 30, h: 20 } }, layers: 4 })
    doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R1', at: [-8, 0] })
    doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R2', at: [8, 0] })
    doc = await run(doc, k, 'connect', { nets: [{ name: 'A', pins: ['R1.2', 'R2.1'] }, { name: 'B', pins: ['R1.1', 'R2.2'] }] })
    await expect(run(doc, k, 'add_via', { net: 'A', at: [0, 0], span: ['F.Cu', 'In4.Cu'] })).rejects.toThrow(/In4.Cu is not on a 4-layer board/)
    doc = await run(doc, k, 'add_via', { net: 'A', at: [0, 3], span: ['F.Cu', 'In1.Cu'] })
    doc = await run(doc, k, 'add_via', { net: 'A', at: [0, -3], span: ['In1.Cu', 'In2.Cu'] })
    doc = await run(doc, k, 'add_via', { net: 'B', at: [4, 0], span: ['F.Cu', 'B.Cu'] })
    expect(doc.pcb!.vias.map((v) => v.span)).toEqual([['F.Cu', 'In1.Cu'], ['In1.Cu', 'In2.Cu'], undefined])
    // A B track on B.Cu right over the blind via: no clash, the via is not on B.Cu.
    doc = await run(doc, k, 'add_track', { net: 'B', layer: 'B.Cu', points: [[-3, 3], [3, 3]] })
    k.build(doc)
    const st = k.boardState(doc, { drc: true })!
    expect(st.drc!.filter((v) => v.objects?.includes('via 1'))).toEqual([])
    const files = fabFiles(doc.pcb!, st.board, st.zones)
    expect(files['board-Blind-L1-L2.drl']).toContain('TF.FileFunction,Plated,1,2,Blind')
    expect(files['board-Buried-L2-L3.drl']).toContain('TF.FileFunction,Plated,2,3,Buried')
    // The through via stays in the PTH file, the blind/buried ones do not.
    expect(files['board-PTH.drl']).toContain('X4.0000Y0.0000')
    expect(files['board-PTH.drl']).not.toContain('X0.0000Y3.0000')
    // On B.Cu only the through via is flashed.
    expect((files['board-B_Cu.gbl'].match(/D03\*/g) ?? []).length).toBe(1)
  })
})
