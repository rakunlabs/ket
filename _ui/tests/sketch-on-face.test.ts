import { describe, expect, it } from 'vitest'

import { type Ctx, type Doc, applyOp, command, emptyDoc, localKernel, parseArgs } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import './setup'

function run(doc: Doc, cmd: string, args: unknown): Doc {
  return applyOp(doc, { cmd, args: parseArgs(command(cmd)!, args) }).doc
}

async function query(doc: Doc, cmd: string, args: unknown = {}): Promise<any> {
  const def = command(cmd)!
  const ctx: Ctx = { doc, kernel: localKernel(new Kernel(), doc) }
  return def.run!(ctx, parseArgs(def, args) as never)
}

function built(doc: Doc) {
  const k = new Kernel()
  const b = k.build(doc)
  return { k, b, f: (n: string) => b.features.find((x) => x.name === n)! }
}

function caseWithSketchOnTop(): Doc {
  let doc = emptyDoc()
  doc = run(doc, 'set_parameters', { parameters: [{ name: 'h', expr: 10 }] })
  doc = run(doc, 'box', { name: 'case', size: [40, 30, 'h'] })
  doc = run(doc, 'sketch', { name: 'boss_outline', on: { feature: 'case', face: { where: '>Z' } } })
  doc = run(doc, 'add_to_sketch', { sketch: 'boss_outline', shapes: [{ kind: 'circle', prefix: 'c', center: [10, 5], r: 3 }] })
  return doc
}

describe('sketch on a face', () => {
  it('extrudes out of the face and follows it when the body changes', () => {
    let doc = caseWithSketchOnTop()
    doc = run(doc, 'extrude', { name: 'boss', sketch: 'boss_outline', distance: 4 })
    let { f } = built(doc)
    expect(f('boss').ok).toBe(true)
    // Top face at z = 10, center (0, 0): the circle sits at (10, 5) and rises 4 mm.
    expect(f('boss').bbox).toEqual([[7, 2, 10], [13, 8, 14]])

    doc = run(doc, 'set_parameters', { parameters: [{ name: 'h', expr: 25 }] })
    ;({ f } = built(doc))
    expect(f('boss').bbox).toEqual([[7, 2, 25], [13, 8, 29]])
  })

  it('cuts a pocket with a negative distance', () => {
    let doc = caseWithSketchOnTop()
    doc = run(doc, 'extrude', { name: 'pocket_tool', sketch: 'boss_outline', distance: -3 })
    doc = run(doc, 'boolean', { name: 'case_cut', op: 'cut', target: 'case', tools: ['pocket_tool'] })
    const { f } = built(doc)
    expect(f('pocket_tool').bbox).toEqual([[7, 2, 7], [13, 8, 10]])
    expect(f('case_cut').warnings).toBeUndefined()
    expect(f('case_cut').volume).toBeCloseTo(40 * 30 * 10 - Math.PI * 9 * 3, 0)
  })

  it('works on a side face, with offset along the normal', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'case', size: [40, 30, 10] })
    doc = run(doc, 'sketch', { name: 'tab', on: { feature: 'case', face: { where: '>X' } }, offset: 1 })
    doc = run(doc, 'add_to_sketch', { sketch: 'tab', shapes: [{ kind: 'rect', prefix: 'r', center: [0, 0], w: 6, h: 4 }] })
    doc = run(doc, 'extrude', { name: 'tab_body', sketch: 'tab', distance: 2 })
    const { f } = built(doc)
    // +X face at x = 20, center (20, 0, 5); u = world Y, v = normal × u = Z.
    expect(f('tab_body').bbox).toEqual([[21, -3, 3], [23, 3, 7]])
  })

  it('reports the frame and says what is wrong with the selector', async () => {
    let doc = caseWithSketchOnTop()
    const r = await query(doc, 'solve_sketch', { name: 'boss_outline' })
    expect(r.frame).toEqual({ origin: [0, 0, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })

    doc = run(doc, 'sketch', { name: 'many', on: { feature: 'case', face: { where: '|Z' } }, replace: true })
    const bad = await query(doc, 'solve_sketch', { name: 'many' })
    expect(bad.frame_error).toMatch(/matches 2 faces of "case".*exactly one/)

    doc = run(doc, 'cylinder', { name: 'rod', r: 3, h: 10, translate: [60, 0, 0] })
    doc = run(doc, 'sketch', { name: 'curved', on: { feature: 'rod', face: { type: 'cylinder' } } })
    const curved = await query(doc, 'solve_sketch', { name: 'curved' })
    expect(curved.frame_error).toMatch(/cylinder, not flat/)
  })

  it('is renamed and protected with its feature', () => {
    let doc = caseWithSketchOnTop()
    doc = run(doc, 'extrude', { name: 'boss', sketch: 'boss_outline', distance: 4 })
    doc = run(doc, 'rename_feature', { name: 'case', to: 'shell' })
    expect(doc.sketches[0].on!.feature).toBe('shell')
    expect(built(doc).f('boss').ok).toBe(true)
    expect(() => run(doc, 'delete_features', { names: ['shell'] })).toThrow(/boss uses shell/)
    doc = run(doc, 'delete_features', { names: ['shell'], cascade: true })
    expect(doc.sketches).toEqual([])
    expect(doc.features).toEqual([])
  })

  it('needs a plane or a face', () => {
    expect(() => run(emptyDoc(), 'sketch', { name: 's' })).toThrow(/plane .* or on:/)
    expect(() => run(emptyDoc(), 'sketch', { name: 's', on: { feature: 'nope', face: { where: '>Z' } } })).toThrow(/no feature "nope"/)
  })
})
