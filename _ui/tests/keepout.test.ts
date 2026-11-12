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

/** Two resistors left and right; a keep-out wall between them across most of the board. */
async function board(k: Kernel, forbid: string[] = ['tracks', 'vias', 'pours']) {
  let doc = emptyDoc()
  doc = await run(doc, k, 'set_board', { outline: { rect: { w: 40, h: 30 } } })
  doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R1', at: [-12, 0], pin_names: { 1: 'A', 2: 'B' } })
  doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R2', at: [12, 0], pin_names: { 1: 'A', 2: 'B' } })
  doc = await run(doc, k, 'connect', { nets: [{ name: 'SIG', pins: ['R1.2', 'R2.1'] }, { name: 'GND', pins: ['R1.1', 'R2.2'] }] })
  doc = await run(doc, k, 'add_keepout', { name: 'wall', rect: { at: [0, -3], w: 4, h: 24 }, forbid })
  return doc
}

describe('keep-outs', () => {
  it('autoroute goes around them and DRC is clean', async () => {
    const k = new Kernel()
    let doc = await board(k)
    k.build(doc)
    doc = await run(doc, k, 'autoroute', { timeout: 60 })
    k.build(doc)
    const drc = await query(doc, k, 'run_drc')
    expect(drc.violations.filter((v: any) => v.rule === 'keepout')).toEqual([])
    // Both nets cross x = 0 only past the wall's top (y > 9): every segment that spans x = 0 does so there.
    for (const t of doc.pcb!.tracks)
      for (let i = 1; i < t.points.length; i++) {
        const [[ax, ay], [bx, by]] = [t.points[i - 1], t.points[i]]
        if ((ax <= 0) === (bx <= 0)) continue
        const y = ay + ((by - ay) * (0 - ax)) / (bx - ax)
        expect(y).toBeGreaterThan(9)
      }
    const info = await query(doc, k, 'get_board')
    expect(info.routing.routed).toBe('2/2 nets')
    expect(info.keepouts).toEqual([{ name: 'wall', forbid: ['tracks', 'vias', 'pours'], layers: 'all', points: 4 }])
  }, 120_000)

  it('pours leave them empty', async () => {
    const k = new Kernel()
    let doc = await board(k)
    doc = await run(doc, k, 'add_zone', { net: 'GND', layer: 'F.Cu' })
    k.build(doc)
    const full = (await query(doc, k, 'get_board')).zones[0].area
    expect(full).toBeGreaterThan(500)
    doc = await run(doc, k, 'remove_keepouts', { names: ['wall'] })
    k.build(doc)
    const without = (await query(doc, k, 'get_board')).zones[0].area
    // The 4 × 24 mm wall is cut out of the pour.
    expect(without - full).toBeGreaterThan(90)
  }, 60_000)

  it('DRC reports copper and parts inside them', async () => {
    const k = new Kernel()
    let doc = await board(k, ['tracks', 'vias', 'parts'])
    doc = await run(doc, k, 'add_track', { net: 'SIG', layer: 'F.Cu', points: [[-11.2, 0], [11.2, 0]] })
    doc = await run(doc, k, 'add_via', { net: 'GND', at: [0, -5] })
    doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R3', at: [0, 5] })
    k.build(doc)
    const drc = await query(doc, k, 'run_drc')
    const msgs = drc.violations.filter((v: any) => v.rule === 'keepout').map((v: any) => v.message)
    expect(msgs.some((m: string) => /track 1 \(SIG\) runs through keepout wall/.test(m))).toBe(true)
    expect(msgs.some((m: string) => /via 1 \(GND\) is inside keepout wall/.test(m))).toBe(true)
    expect(msgs.some((m: string) => /R3 sits in keepout wall/.test(m))).toBe(true)
  }, 60_000)

  it('auto_place keeps parts out', async () => {
    const k = new Kernel()
    let doc = emptyDoc()
    doc = await run(doc, k, 'set_board', { outline: { rect: { w: 20, h: 10 } } })
    doc = await run(doc, k, 'add_keepout', { name: 'left', rect: { at: [-5, 0], w: 10, h: 10 }, forbid: ['parts'] })
    for (const ref of ['R1', 'R2', 'R3']) doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref, at: [0, 0] })
    k.build(doc)
    doc = await run(doc, k, 'auto_place', {})
    for (const c of doc.pcb!.components) expect(Number(c.at[0])).toBeGreaterThan(0.5)
  }, 60_000)

  it('rejects bad input with a fix', async () => {
    const k = new Kernel()
    const doc = await run(emptyDoc(), k, 'set_board', { outline: { rect: { w: 20, h: 10 } } })
    await expect(run(doc, k, 'add_keepout', { name: 'x', forbid: ['parts'] })).rejects.toThrow(/polygon or rect/)
    await expect(run(doc, k, 'add_keepout', { name: 'x', rect: { at: [0, 0], w: 1, h: 1 }, layers: ['In1.Cu'] })).rejects.toThrow(/4-layer/)
    await expect(run(doc, k, 'remove_keepouts', { names: ['nope'] })).rejects.toThrow(/no keep-out nope/)
  })
})
