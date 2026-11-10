import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, summarize, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'

import './setup'

function run(doc: Doc, cmd: string, args: unknown): Doc {
  return applyOp(doc, { cmd, args }).doc
}

async function query(doc: Doc, kernel: Kernel, cmd: string, args: unknown = {}): Promise<any> {
  const def = command(cmd)!
  return def.run!({ doc, kernel: localKernel(kernel, doc) }, parseArgs(def, args) as never)
}

describe('enclosure', () => {
  it('models a case around a board and verifies it', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', {
      parameters: [
        { name: 'board_w', expr: 50 },
        { name: 'board_d', expr: 26 },
        { name: 'board_t', expr: 1.6 },
        { name: 'gap', expr: 0.5 },
        { name: 'wall', expr: 2 },
        { name: 'case_w', expr: 'board_w + 2*(wall+gap)' },
        { name: 'case_d', expr: 'board_d + 2*(wall+gap)' },
        { name: 'case_h', expr: 15 },
      ],
    })
    doc = run(doc, 'box', { name: 'case_body', size: ['case_w', 'case_d', 'case_h'] })
    doc = run(doc, 'fillet', { name: 'case_round', target: 'case_body', r: 3, edges: { where: '|Z' } })
    doc = run(doc, 'shell', { name: 'case_shell', target: 'case_round', thickness: 'wall' })
    doc = run(doc, 'box', { name: 'usb', size: [10, 4, 9], translate: ['-case_w/2', 0, 'wall + 3'], center: true })
    doc = run(doc, 'boolean', { name: 'case', op: 'cut', target: 'case_shell', tools: ['usb'] })
    doc = run(doc, 'box', { name: 'pcb', size: ['board_w', 'board_d', 'board_t'], translate: [0, 0, 'wall + 2'], color: '#2f7d32' })
    doc = run(doc, 'box', { name: 'cavity', size: ['case_w - 2*wall', 'case_d - 2*wall', 'case_h'], translate: [0, 0, 'wall'], hidden: true })
    doc = run(doc, 'set_checks', {
      checks: [
        { name: 'wall_ok', kind: 'expr', expr: 'wall >= 1.2' },
        { name: 'pcb_fits', kind: 'inside', inner: 'pcb', outer: 'cavity', margin: 'gap' },
        { name: 'pcb_clear', kind: 'no_overlap', a: 'pcb', b: 'case' },
      ],
    })

    const k = new Kernel()
    const build = k.build(doc)
    expect(build.parameterError).toBeUndefined()
    expect(build.features.filter((f) => !f.ok)).toEqual([])
    expect(build.parameters.case_w).toBe(55)
    expect(build.bodies.sort()).toEqual(['case', 'pcb'])

    const caseSt = build.features.find((f) => f.name === 'case')!
    expect(caseSt.bbox).toEqual([[-27.5, -15.5, 0], [27.5, 15.5, 15]])
    // The USB cut removed material.
    const shellSt = build.features.find((f) => f.name === 'case_shell')!
    expect(caseSt.volume!).toBeLessThan(shellSt.volume!)

    const checks = (await query(doc, k, 'run_checks')) as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }
    expect(checks.checks.map((c) => [c.name, c.ok])).toEqual([
      ['wall_ok', true],
      ['pcb_fits', true],
      ['pcb_clear', true],
    ])
    expect(checks.ok).toBe(true)

    // A parameter change that breaks a requirement shows up in the checks.
    const tight = run(doc, 'set_parameters', { parameters: [{ name: 'gap', expr: 0 }, { name: 'wall', expr: 1 }] })
    const after = (await query(tight, k, 'run_checks')) as { ok: boolean; checks: { name: string; ok: boolean }[] }
    expect(after.ok).toBe(false)
    expect(after.checks.find((c) => c.name === 'wall_ok')!.ok).toBe(false)

    const summary = summarize(doc, k.build(doc))
    expect(summary.parameters).toContain('case_w = board_w + 2*(wall+gap) → 55')
    expect(summary.features.find((f) => f.name === 'case')!.body).toBe(true)

    const meshes = k.meshes(k.build(doc))
    expect(meshes.map((m) => m.name).sort()).toEqual(['case', 'pcb'])
    expect(meshes[0].triangles.length).toBeGreaterThan(0)
  }, 120_000)

  it('explains mistakes so a model can fix them', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'a', size: [10, 10, 10] })
    expect(() => run(doc, 'box', { name: 'a', size: [1, 1, 1] })).toThrow(/replace: true/)
    expect(() => run(doc, 'boolean', { name: 'b', op: 'cut', target: 'a', tools: ['nope'] })).toThrow(/"nope" does not exist; features are: a/)
    expect(() => run(doc, 'box', { name: 'bad name', size: [1, 1, 1] })).toThrow(/letters, digits/)

    doc = run(doc, 'box', { name: 'c', size: ['w', 1, 1] })
    const k = new Kernel()
    const st = k.build(doc).features.find((f) => f.name === 'c')!
    expect(st.ok).toBe(false)
    expect(st.error).toMatch(/unknown name "w"/)

    doc = run(doc, 'delete_features', { names: ['c'] })
    doc = run(doc, 'box', { name: 'far', size: [2, 2, 2], translate: [50, 0, 0] })
    doc = run(doc, 'boolean', { name: 'cut', op: 'cut', target: 'a', tools: ['far'] })
    const cut = k.build(doc).features.find((f) => f.name === 'cut')!
    expect(cut.warnings?.join()).toMatch(/removed no material/)

    doc = run(doc, 'fillet', { name: 'round', target: 'cut', r: 20 })
    const fl = k.build(doc).features.find((f) => f.name === 'round')!
    expect(fl.ok).toBe(false)
    expect(fl.error).toMatch(/too large/)

    expect(() => run(doc, 'delete_features', { names: ['a'] })).toThrow(/cut uses a/)
  }, 120_000)

  it('selects faces and edges by meaning', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'b', size: [20, 10, 5] })
    const k = new Kernel()
    k.build(doc)
    const top = await query(doc, k, 'list_faces', { name: 'b', selector: { where: '>Z' } })
    expect(top.count).toBe(1)
    expect(top.faces[0].center).toEqual([0, 0, 5])
    const vertical = await query(doc, k, 'list_edges', { name: 'b', selector: { where: '|Z' } })
    expect(vertical.count).toBe(4)
    const sides = await query(doc, k, 'list_faces', { name: 'b', selector: { where: '#Z' } })
    expect(sides.count).toBe(4)
  }, 60_000)

  it('rebuilds only what changed', () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'h', expr: 5 }] })
    doc = run(doc, 'box', { name: 'b', size: [20, 10, 'h'] })
    doc = run(doc, 'cylinder', { name: 'c', r: 2, h: 20, translate: [0, 0, -1] })
    doc = run(doc, 'boolean', { name: 'r', op: 'cut', target: 'b', tools: ['c'] })
    const k = new Kernel()
    const v1 = k.build(doc).features.find((f) => f.name === 'r')!.volume!
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'h', expr: 10 }] })
    const v2 = k.build(doc).features.find((f) => f.name === 'r')!.volume!
    expect(v2).toBeCloseTo(v1 * 2, 3)
  }, 60_000)
})
