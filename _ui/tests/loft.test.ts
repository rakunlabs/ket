import { describe, expect, it } from 'vitest'

import { applyOp, emptyDoc, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'

import './setup'

const run = (doc: Doc, cmd: string, args: unknown): Doc => applyOp(doc, { cmd, args }).doc

describe('loft and sweep', () => {
  it('lofts a square into a circle', () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'h', expr: 20 }] })
    doc = run(doc, 'loft', {
      name: 'funnel',
      sections: [
        { plane: 'XY', profile: { kind: 'rect', w: 20, h: 20 } },
        { plane: 'XY', offset: 'h', profile: { kind: 'circle', r: 5 } },
      ],
    })
    const r = new Kernel().build(doc)
    const f = r.features.find((x) => x.name === 'funnel')!
    expect(f.ok, f.error).toBe(true)
    expect(f.bbox![1][2]).toBeCloseTo(20, 3)
    // Between the prism (8000) and the cone-ish lower bound.
    expect(f.volume!).toBeGreaterThan(2500)
    expect(f.volume!).toBeLessThan(8000)
  })

  it('sweeps a circle along a bent path', () => {
    let doc = emptyDoc()
    doc = run(doc, 'sweep', {
      name: 'handle',
      profile: { kind: 'circle', r: 2 },
      path: [
        [-20, 0, 0],
        [-20, 0, 15],
        [20, 0, 15],
        [20, 0, 0],
      ],
      bend: 5,
    })
    const k = new Kernel()
    const f = k.build(doc).features[0]
    expect(f.ok, f.error).toBe(true)
    // Path length: 2·(15−5) + (40−10) + 2·(π/2·5) = 50 + 5π; volume = πr²·L.
    const L = 50 + 5 * Math.PI
    expect(f.volume!).toBeCloseTo(Math.PI * 4 * L, 0)
    expect(f.bbox![1][2]).toBeCloseTo(17, 1)
    expect(f.solids).toBe(1)
  })

  it('explains a bend that does not fit', () => {
    const doc = run(emptyDoc(), 'sweep', { name: 's', profile: { kind: 'circle', r: 1 }, path: [[0, 0, 0], [0, 0, 3], [10, 0, 3]], bend: 5 })
    const f = new Kernel().build(doc).features[0]
    expect(f.ok).toBe(false)
    expect(f.error).toMatch(/bend 5 is too large/)
  })
})

describe('mirror and polar pattern', () => {
  it('mirrors a body across a plane, keeping or replacing it', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'left', size: [10, 4, 6], translate: [0, 15, 0] })
    doc = run(doc, 'mirror', { name: 'both', target: 'left', plane: 'XZ' })
    doc = run(doc, 'box', { name: 'tab', size: [2, 2, 2], translate: [10, 0, 0] })
    doc = run(doc, 'mirror', { name: 'tab_m', target: 'tab', plane: 'YZ', offset: 2, keep: false })
    const r = new Kernel().build(doc)
    const both = r.features.find((x) => x.name === 'both')!
    expect(both.ok, both.error).toBe(true)
    expect(both.solids).toBe(2)
    expect(both.volume!).toBeCloseTo(480, 3)
    expect(both.bbox![0][1]).toBeCloseTo(-17, 3)
    expect(both.warnings).toBeUndefined()
    const tab = r.features.find((x) => x.name === 'tab_m')!
    // x in [9, 11] mirrored about x = 2 → [-7, -5].
    expect(tab.bbox![0][0]).toBeCloseTo(-7, 3)
    expect(tab.bbox![1][0]).toBeCloseTo(-5, 3)
  })

  it('repeats a spoke around an axis', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'spoke', size: [1, 1, 5], translate: [0, 0, 5] })
    doc = run(doc, 'pattern', { name: 'spokes', kind: 'polar', target: 'spoke', count: 4, axis: 'Y', center: [0, 0, 5] })
    doc = run(doc, 'box', { name: 'tooth', size: [1, 1, 1], translate: [10, 0, 0] })
    doc = run(doc, 'pattern', { name: 'arc', kind: 'polar', target: 'tooth', count: 3, angle: 90 })
    const r = new Kernel().build(doc)
    const s = r.features.find((x) => x.name === 'spokes')!
    expect(s.ok, s.error).toBe(true)
    expect(s.bbox![0][0]).toBeCloseTo(-5, 3)
    expect(s.bbox![1][0]).toBeCloseTo(5, 3)
    expect(s.bbox![0][2]).toBeCloseTo(0, 3)
    expect(s.bbox![1][2]).toBeCloseTo(10, 3)
    const a = r.features.find((x) => x.name === 'arc')!
    // Copies at 0°, 45° and 90°: the last one sits on +Y.
    expect(a.bbox![1][1]).toBeCloseTo(10.5, 3)
    expect(a.bbox![0][0]).toBeCloseTo(-0.5, 3)
  })

  it('rejects polar arguments on linear patterns', () => {
    expect(() => run(emptyDoc(), 'pattern', { name: 'p', kind: 'linear', target: 'x', count: 2, step: [1, 0, 0], axis: 'Z' })).toThrow(/"polar" only/)
  })
})

describe('union of separate parts', () => {
  it('warns once, and not at all with separate: true', () => {
    let doc = emptyDoc()
    for (const i of [0, 1, 2, 3]) doc = run(doc, 'box', { name: `k${i}`, size: [1, 1, 1], translate: [i * 3, 0, 0] })
    doc = run(doc, 'boolean', { name: 'keys', op: 'union', target: 'k0', tools: ['k1', 'k2'] })
    doc = run(doc, 'boolean', { name: 'keys2', op: 'union', target: 'keys', tools: ['k3'], separate: true })
    const r = new Kernel().build(doc)
    const a = r.features.find((x) => x.name === 'keys')!
    expect(a.warnings).toHaveLength(1)
    expect(a.warnings![0]).toMatch(/"k1", "k2" do not touch.*separate: true/)
    const b = r.features.find((x) => x.name === 'keys2')!
    expect(b.solids).toBe(4)
    expect(b.warnings).toBeUndefined()
  })

  it('update_feature moves a new standalone tool before the boolean, but not a derived body', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'a', size: [1, 1, 1] })
    doc = run(doc, 'box', { name: 'b', size: [1, 1, 1] })
    doc = run(doc, 'boolean', { name: 'u', op: 'union', target: 'a', tools: ['b'] })
    doc = run(doc, 'box', { name: 'c', size: [1, 1, 1] })
    const moved = run(doc, 'update_feature', { name: 'u', set: { tools: ['b', 'c'] } })
    expect(moved.features.map((f) => f.name)).toEqual(['a', 'b', 'c', 'u'])
    // A tool built from later features moves with them.
    doc = run(doc, 'box', { name: 'd', size: [1, 1, 1] })
    doc = run(doc, 'boolean', { name: 'cd', op: 'union', target: 'c', tools: ['d'] })
    const tree = run(doc, 'update_feature', { name: 'u', set: { tools: ['b', 'cd'] } })
    expect(tree.features.map((f) => f.name)).toEqual(['a', 'b', 'c', 'd', 'cd', 'u'])
    // ...but not when something else also uses it.
    doc = run(doc, 'box', { name: 'e', size: [1, 1, 1] })
    doc = run(doc, 'boolean', { name: 'ecd', op: 'union', target: 'e', tools: ['cd'] })
    expect(() => run(doc, 'update_feature', { name: 'u', set: { tools: ['b', 'cd'] } })).toThrow(/is defined after "u"/)
  })

  it('rename_feature can leave checks on the old name for the next step', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'case', size: [10, 10, 10] })
    doc = run(doc, 'box', { name: 'part', size: [1, 1, 1] })
    doc = run(doc, 'set_checks', { checks: [{ kind: 'no_overlap', name: 'fit', a: 'part', b: 'case' }] })
    doc = run(doc, 'rename_feature', { name: 'case', to: 'case_a', keep_checks: true })
    doc = run(doc, 'box', { name: 'cutter', size: [2, 2, 2] })
    doc = run(doc, 'boolean', { name: 'case', op: 'cut', target: 'case_a', tools: ['cutter'] })
    expect((doc.checks[0] as { b: string }).b).toBe('case')
  })
})

describe('measure_between', () => {
  it('measures points and features', async () => {
    const { command, localKernel, parseArgs } = await import('../src/engine')
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'a', size: [10, 10, 10] })
    doc = run(doc, 'box', { name: 'b', size: [10, 10, 10], translate: [15, 0, 0] })
    const k = new Kernel()
    const q = (args: unknown) => command('measure_between')!.run!({ doc, kernel: localKernel(k, doc) }, parseArgs(command('measure_between')!, args) as never) as Promise<any>
    expect((await q({ a: 'a', b: 'b' })).distance).toBeCloseTo(5, 3)
    expect((await q({ a: [0, 0, 20], b: 'a' })).distance).toBeCloseTo(10, 3)
    expect((await q({ a: [0, 0, 5], b: 'a' })).distance).toBe(0)
    const pp = await q({ a: [0, 0, 0], b: [3, 4, 0] })
    expect(pp.distance).toBe(5)
    expect(pp.delta).toEqual([3, 4, 0])
  })
})

describe('exploded view', () => {
  it('offsets bodies for display only; board parts follow the board', async () => {
    const { explodeOffset } = await import('../src/engine/explode')
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'lift', expr: '20' }] })
    doc = run(doc, 'box', { name: 'base', size: [10, 10, 2] })
    doc = run(doc, 'box', { name: 'lid', size: [10, 10, 2], translate: [0, 0, 5] })
    doc = run(doc, 'box', { name: 'cap1', size: [2, 2, 2] })
    doc = run(doc, 'set_explode', { steps: [{ names: ['lid'], offset: [0, 0, 'lift'] }, { names: ['cap*'], offset: [0, 0, 'lift*2'] }] })
    const p = new Map([['lift', 20]])
    expect(explodeOffset(doc, p, 'lid')).toEqual([0, 0, 20])
    expect(explodeOffset(doc, p, 'cap1')).toEqual([0, 0, 40])
    expect(explodeOffset(doc, p, 'base')).toBeUndefined()
    expect(() => run(doc, 'set_explode', { steps: [{ names: ['nope'], offset: [0, 0, 1] }] })).toThrow(/no body "nope"/)
    doc.pcb = { components: [{ ref: 'U1' }] } as never
    doc.explode = { steps: [{ names: ['board'], offset: [0, 0, 5] }] }
    expect(explodeOffset(doc, p, 'part_U1')).toEqual([0, 0, 5])
    expect(run(doc, 'set_explode', { steps: [] }).explode).toBeUndefined()
  })
})

describe('profile inset', () => {
  it('makes a wall of even thickness from one outline', async () => {
    const { Kernel } = await import('../src/engine/kernel')
    const k = new Kernel()
    const L = [[-10, -5], [10, -5], [10, 5], [2, 5], [2, 12], [-2, 12], [-2, 5], [-10, 5]]
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'wall', expr: '1.5' }] })
    doc = run(doc, 'extrude', { name: 'outer', plane: 'XY', profile: { kind: 'polygon', points: L }, distance: 5 })
    doc = run(doc, 'extrude', { name: 'inner', plane: 'XY', profile: { kind: 'polygon', points: L, inset: 'wall' }, distance: 6, offset: 1 })
    doc = run(doc, 'boolean', { name: 'cup', op: 'cut', target: 'outer', tools: ['inner'] })
    const r = k.build(doc)
    const inner = r.features.find((f) => f.name === 'inner')!
    expect(inner.bbox![0][0]).toBeCloseTo(-8.5, 3)
    expect(inner.bbox![1][1]).toBeCloseTo(10.5, 3)
    // Area of the inset L: (17 × 7) + (1 × 7) minus nothing: tab 1 wide, from y 3.5 to 10.5.
    expect(inner.volume! / 6).toBeCloseTo(17 * 7 + 1 * 7, 1)
    expect(r.features.find((f) => f.name === 'cup')!.ok).toBe(true)
  })
})

describe('profile inset winding', () => {
  it('shrinks clockwise and counter-clockwise outlines alike', async () => {
    const { Kernel } = await import('../src/engine/kernel')
    const k = new Kernel()
    const ccw = [[-5, -5], [5, -5], [5, 5], [-5, 5]]
    let doc = emptyDoc()
    doc = run(doc, 'extrude', { name: 'a', plane: 'XY', profile: { kind: 'polygon', points: ccw, inset: 1 }, distance: 1 })
    doc = run(doc, 'extrude', { name: 'b', plane: 'XY', profile: { kind: 'polygon', points: [...ccw].reverse(), inset: 1 }, distance: 1 })
    doc = run(doc, 'extrude', { name: 'c', plane: 'XY', profile: { kind: 'polygon', points: ccw, inset: -1 }, distance: 1 })
    const r = k.build(doc)
    expect(r.features.map((f) => Math.round(f.volume!))).toEqual([64, 64, 144])
  })
})
