import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc, type Op } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { writeProjectFile } from '../src/engine/project-file'
import './setup'

async function prepared(doc: Doc, cmd: string, args: unknown): Promise<Op> {
  const def = command(cmd)!
  let a = parseArgs(def, args)
  if (def.prepare) a = await def.prepare({ doc, kernel: localKernel(new Kernel(), doc) }, a as never)
  return { cmd, args: a }
}

/** Runs ops and returns the doc and the op log (what export_project would save). */
async function build(steps: [string, unknown][]): Promise<{ doc: Doc; ops: Op[] }> {
  let doc = emptyDoc()
  const ops: Op[] = []
  for (const [cmd, args] of steps) {
    const op = await prepared(doc, cmd, args)
    doc = applyOp(doc, op).doc
    ops.push(op)
  }
  return { doc, ops }
}

/** A boss block: a parameter, a sketch, a body with a hole, a check; and a power input on the board. */
async function bossBlock() {
  const { ops } = await build([
    ['set_parameters', { parameters: [{ name: 'h', expr: 6 }, { name: 'r', expr: 'h / 2' }] }],
    ['cylinder', { name: 'boss', r: 'r', h: 'h' }],
    ['cylinder', { name: 'pilot', r: 1.25, h: 10, translate: [0, 0, -1] }],
    ['boolean', { name: 'boss_drilled', op: 'cut', target: 'boss', tools: ['pilot'] }],
    ['set_checks', { checks: [{ name: 'tall', kind: 'expr', expr: 'h >= 4' }, { name: 'solid', kind: 'volume', target: 'boss_drilled', min: 1 }] }],
    ['set_board', { outline: { rect: { w: 20, h: 10 } } }],
    ['add_component', { footprint_name: 'pinrow2', ref: 'J1', at: [0, 0], pin_names: { 1: 'VIN', 2: 'GND' } }],
    ['add_component', { footprint_name: '0603', ref: 'C1', at: [4, 0] }],
    ['connect', { nets: [{ name: 'GND', pins: ['J1.2', 'C1.2'] }, { name: 'IN', pins: ['J1.1', 'C1.1'] }] }],
  ])
  return writeProjectFile(ops)
}

describe('insert_block', () => {
  it('puts the same block in twice under prefixes, references intact', async () => {
    const data = await bossBlock()
    let { doc } = await build([
      ['set_board', { outline: { rect: { w: 60, h: 40 } } }],
      ['add_component', { footprint_name: '0603', ref: 'R1', at: [0, 10] }],
      ['connect', { nets: [{ name: 'GND', pins: ['R1.2'] }, { name: 'X', pins: ['R1.1'] }] }],
    ])
    doc = applyOp(doc, await prepared(doc, 'insert_block', { data, prefix: 'left', offset: [-20, 0, 0] })).doc
    doc = applyOp(doc, await prepared(doc, 'insert_block', { data, prefix: 'right', offset: [20, 0, 0] })).doc
    expect(doc.parameters.map((p) => p.name)).toEqual(['left_h', 'left_r', 'right_h', 'right_r'])
    expect(doc.parameters[1].expr).toBe('left_h / 2')
    expect(doc.checks.map((c) => c.name)).toEqual(['left_tall', 'left_solid', 'right_tall', 'right_solid'])
    expect(doc.checks[0]).toMatchObject({ expr: 'left_h >= 4' })
    expect(doc.pcb!.components.map((c) => c.ref).sort()).toEqual(['LEFTC1', 'LEFTJ1', 'R1', 'RIGHTC1', 'RIGHTJ1'])
    // GND joins the design's GND; IN stays the block's own.
    expect(doc.pcb!.nets.find((n) => n.name === 'GND')!.pins.sort()).toEqual(['LEFTC1.2', 'LEFTJ1.2', 'R1.2', 'RIGHTC1.2', 'RIGHTJ1.2'])
    expect(doc.pcb!.nets.find((n) => n.name === 'left_IN')!.pins).toEqual(['LEFTJ1.1', 'LEFTC1.1'])
    expect(doc.pcb!.components.find((c) => c.ref === 'RIGHTJ1')!.at).toEqual([20, 0])
    // It builds: two drilled bosses where they should be, checks on them pass.
    const k = new Kernel()
    const b = k.build(doc)
    expect(b.features.filter((f) => !f.ok)).toEqual([])
    const left = b.features.find((f) => f.name === 'left_boss_drilled')!
    expect(left.bbox).toEqual([[-23, -3, 0], [-17, 3, 6]])
    expect(k.checks(doc).every((c) => c.ok)).toBe(true)
  }, 60_000)

  it('refuses a clash and says to pick another prefix', async () => {
    const data = await bossBlock()
    let { doc } = await build([['set_board', { outline: { rect: { w: 60, h: 40 } } }]])
    doc = applyOp(doc, await prepared(doc, 'insert_block', { data, prefix: 'a' })).doc
    expect(() => applyOp(doc, { cmd: 'insert_block', args: parseArgs(command('insert_block')!, { data, prefix: 'a' }) })).toThrow(/already exist.*another prefix/)
    expect(() => applyOp(emptyDoc(), { cmd: 'insert_block', args: parseArgs(command('insert_block')!, { data, prefix: 'b' }) })).toThrow(/set_board first/)
  }, 60_000)

  it('replays from the op alone', async () => {
    const data = await bossBlock()
    const { ops } = await build([['set_board', { outline: { rect: { w: 60, h: 40 } } }], ['insert_block', { data, prefix: 'p' }]])
    const file = writeProjectFile(ops)
    const { readProjectFile } = await import('../src/engine/project-file')
    expect(readProjectFile(file).doc.features.map((f) => f.name)).toEqual(['p_boss', 'p_pilot', 'p_boss_drilled'])
  }, 60_000)
})
