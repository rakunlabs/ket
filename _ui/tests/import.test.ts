import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import { applyOp, command, emptyDoc, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import './setup'

const URL = 'https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/master/Button_Switch_SMD.3dshapes/SW_SPST_EVQP7C.step'

function run(doc: Doc, cmd: string, args: unknown): Doc {
  return applyOp(doc, { cmd, args: parseArgs(command(cmd)!, args) }).doc
}

describe('import', () => {
  it('places a STEP model as a solid body that checks and booleans can use', async () => {
    const k = new Kernel()
    let doc = emptyDoc()
    doc = run(doc, 'import', { name: 'tact', url: URL, rotate: [0, 0, 90], translate: [10, 0, 0] })
    expect(k.missingImports(doc)).toEqual([URL])
    // Not loaded: the feature fails with a message that says so.
    expect(k.build(doc).features[0].error).toMatch(/not loaded yet/)

    const b = readFileSync('tests/fixtures/SW_SPST_EVQP7C.step')
    await k.loadImport(URL, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
    expect(k.missingImports(doc)).toEqual([])
    const r = k.build(doc)
    expect(r.features[0].ok).toBe(true)
    const bb = r.features[0].bbox!
    // EVQP7C is 4.7 × 3.55 mm; rotated 90° and moved to x = 10.
    expect(bb[1][0] - bb[0][0]).toBeCloseTo(3.55, 1)
    expect(bb[1][1] - bb[0][1]).toBeCloseTo(4.7, 1)
    expect((bb[0][0] + bb[1][0]) / 2).toBeGreaterThan(9)

    // A pocket around it: the case cut keeps clear of the part.
    doc = run(doc, 'box', { name: 'case', size: [20, 20, 4], translate: [10, 0, -1] })
    doc = run(doc, 'box', { name: 'pocket', size: [5, 6, 4], translate: [10, -0.3, -0.5] })
    doc = run(doc, 'boolean', { name: 'case_cut', op: 'cut', target: 'case', tools: ['pocket'] })
    doc = run(doc, 'set_checks', { checks: [{ kind: 'no_overlap', name: 'fits', a: 'tact', b: 'case_cut' }] })
    k.build(doc)
    expect(k.checks(doc).every((c) => c.ok)).toBe(true)

    // A failed download says what went wrong.
    const k2 = new Kernel()
    await k2.loadImport(URL, new Error(`download ${URL}: models can only be downloaded from ...`))
    expect(k2.build(doc).features[0].error).toMatch(/can only be downloaded/)
  }, 120_000)

  it('gives a board part its real model as part_<ref>, on either side', async () => {
    const k = new Kernel()
    const b = readFileSync('tests/fixtures/SW_SPST_EVQP7C.step')
    await k.loadImport(URL, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
    let doc = emptyDoc()
    doc = run(doc, 'set_board', { outline: { rect: { w: 30, h: 20 } }, z: 5 })
    const fp = JSON.parse(readFileSync('tests/fixtures/C25804.json', 'utf8'))
    const { parsePart } = await import('../src/engine/pcb/easyeda')
    const { footprint, info } = parsePart(fp)
    const add = (ref: string, side: string) =>
      run(doc, 'add_component', { lcsc: 'C25804', ref, at: [5, 2], side, footprint, info, model: { url: URL, rotate: [0, 0, 90] } })
    doc = add('S1', 'top')
    doc = run(add('S2', 'bottom'), 'move_component', { moves: [{ ref: 'S2', at: [-5, 2] }] })
    const r = k.build(doc)
    const s1 = r.features.find((f) => f.name === 'part_S1')!
    const s2 = r.features.find((f) => f.name === 'part_S2')!
    expect(s1.type).toBe('import')
    // Top: from the board top (z 6.6) up; bottom: mirrored below the board (z 5).
    expect(s1.bbox![0][2]).toBeCloseTo(6.6 - 0.5, 1)
    expect(s2.bbox![1][2]).toBeCloseTo(5 + 0.5, 1)
    expect(s2.bbox![0][2]).toBeCloseTo(5 - 1.35, 1)
    expect((s1.bbox![0][0] + s1.bbox![1][0]) / 2).toBeCloseTo(5.325, 2)
    // null goes back to the block.
    doc = run(doc, 'move_component', { moves: [{ ref: 'S1', model: null }] })
    expect(k.build(doc).features.find((f) => f.name === 'part_S1')!.type).toBe('extrude')
  }, 120_000)
})
