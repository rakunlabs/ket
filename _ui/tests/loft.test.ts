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
