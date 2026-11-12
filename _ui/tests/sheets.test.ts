import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { MAIN_SHEET, schematic, sheetsOf } from '../src/engine/pcb/schematic'
import './setup'

async function run(doc: Doc, cmd: string, args: unknown): Promise<Doc> {
  const def = command(cmd)!
  let a = parseArgs(def, args)
  if (def.prepare) a = await def.prepare({ doc, kernel: localKernel(new Kernel(), doc) }, a as never)
  return applyOp(doc, { cmd, args: a }).doc
}

async function design(): Promise<Doc> {
  let doc = await run(emptyDoc(), 'set_board', { outline: { rect: { w: 40, h: 30 } } })
  doc = await run(doc, 'add_component', { footprint_name: 'pinrow2', ref: 'J1', at: [-10, 0], pin_names: { 1: 'VBUS', 2: 'GND' } })
  doc = await run(doc, 'add_component', { footprint_name: 'soic8', ref: 'U1', at: [0, 0] })
  doc = await run(doc, 'add_component', { footprint_name: '0603', ref: 'C1', at: [5, 5] })
  doc = await run(doc, 'connect', { nets: [{ name: 'VBUS', pins: ['J1.1', 'U1.8'] }, { name: 'GND', pins: ['J1.2', 'U1.4', 'C1.2'] }, { name: 'SIG', pins: ['U1.2', 'C1.1'] }] })
  return doc
}

describe('schematic sheets', () => {
  it('one sheet by default', async () => {
    const doc = await design()
    expect(sheetsOf(doc.pcb!)).toEqual([MAIN_SHEET])
    const s = schematic(doc.pcb!)
    expect(s.symbols.map((x) => x.ref).sort()).toEqual(['C1', 'J1', 'U1'])
    expect(s.offSheet).toEqual({})
  })

  it('splits parts over sheets and labels the nets that cross', async () => {
    let doc = await design()
    doc = await run(doc, 'set_sheet', { refs: ['J1'], sheet: 'power' })
    expect(sheetsOf(doc.pcb!)).toEqual(['main', 'power'])
    const main = schematic(doc.pcb!, 'main')
    expect(main.symbols.map((x) => x.ref).sort()).toEqual(['C1', 'U1'])
    expect(main.offSheet).toEqual({ VBUS: ['power'], GND: ['power'] })
    const power = schematic(doc.pcb!, 'power')
    expect(power.symbols.map((x) => x.ref)).toEqual(['J1'])
    expect(power.offSheet).toEqual({ VBUS: ['main'], GND: ['main'] })
    // The net stays the net: nothing changed electrically.
    expect(doc.pcb!.nets).toEqual((await design()).pcb!.nets)
    // An off-sheet net keeps its labels even when wired on this sheet.
    expect(power.symbols[0].labels).toEqual({ '1': true, '2': true })
    doc = await run(doc, 'set_sheet', { refs: ['J1'] })
    expect(sheetsOf(doc.pcb!)).toEqual(['main'])
    await expect(run(doc, 'set_sheet', { refs: ['J1'], sheet: '1 bad' })).rejects.toThrow(/sheet name/)
  })
})
