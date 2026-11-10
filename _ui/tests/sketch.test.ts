import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'

import './setup'

function run(doc: Doc, cmd: string, args: unknown): Doc {
  return applyOp(doc, { cmd, args }).doc
}

async function query(doc: Doc, kernel: Kernel, cmd: string, args: unknown = {}): Promise<any> {
  const def = command(cmd)!
  return def.run!({ doc, kernel: localKernel(kernel, doc) }, parseArgs(def, args) as never)
}

describe('sketches', () => {
  it('solves an L bracket driven by parameters and extrudes it', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', {
      parameters: [
        { name: 'arm', expr: 40 },
        { name: 'height', expr: 30 },
        { name: 'thick', expr: 5 },
      ],
    })
    // Deliberately sloppy starting points: the solver must square them up.
    doc = run(doc, 'sketch', {
      name: 'bracket',
      plane: 'XZ',
      points: [
        { id: 'o', x: 0, y: 0, fixed: true },
        { id: 'a', x: 37, y: 1 },
        { id: 'b', x: 39, y: 6 },
        { id: 'c', x: 6, y: 4 },
        { id: 'd', x: 4, y: 28 },
        { id: 'e', x: 1, y: 33 },
      ],
      entities: [
        { id: 'l1', kind: 'line', a: 'o', b: 'a' },
        { id: 'l2', kind: 'line', a: 'a', b: 'b' },
        { id: 'l3', kind: 'line', a: 'b', b: 'c' },
        { id: 'l4', kind: 'line', a: 'c', b: 'd' },
        { id: 'l5', kind: 'line', a: 'd', b: 'e' },
        { id: 'l6', kind: 'line', a: 'e', b: 'o' },
      ],
      constraints: [
        { kind: 'horizontal', line: 'l1' },
        { kind: 'vertical', line: 'l2' },
        { kind: 'horizontal', line: 'l3' },
        { kind: 'vertical', line: 'l4' },
        { kind: 'horizontal', line: 'l5' },
        { kind: 'vertical', line: 'l6' },
        { kind: 'length', line: 'l1', value: 'arm' },
        { kind: 'length', line: 'l6', value: 'height' },
        { kind: 'length', line: 'l2', value: 'thick' },
        { kind: 'length', line: 'l5', value: 'thick' },
      ],
    })
    const k = new Kernel()
    k.build(doc)
    const solved = await query(doc, k, 'solve_sketch', { name: 'bracket' })
    expect(solved.status).toBe('solved')
    expect(solved.dof).toBe(0)
    expect(solved.points.b).toEqual([40, 5])
    expect(solved.points.d).toEqual([5, 30])
    expect(solved.loops).toHaveLength(1)

    doc = run(doc, 'extrude', { name: 'bracket_body', sketch: 'bracket', distance: 20 })
    const st = k.build(doc).features.find((f) => f.name === 'bracket_body')!
    expect(st.error).toBeUndefined()
    // L area = 40*5 + 5*25 = 325; XZ extrudes along +Y.
    expect(st.volume).toBeCloseTo(325 * 20, 3)
    expect(st.bbox).toEqual([[0, 0, 0], [40, 20, 30]])

    // Parameters drive the sketch.
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'arm', expr: 60 }] })
    const st2 = k.build(doc).features.find((f) => f.name === 'bracket_body')!
    expect(st2.volume).toBeCloseTo((60 * 5 + 5 * 25) * 20, 3)
  }, 60_000)

  it('reports conflicts and missing constraints by number', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'sketch', { name: 's', plane: 'XY' })
    doc = run(doc, 'add_to_sketch', { sketch: 's', shapes: [{ kind: 'rect', prefix: 'r', w: 40, h: 20 }] })
    const k = new Kernel()
    k.build(doc)
    let solved = await query(doc, k, 'solve_sketch', { name: 's' })
    expect(solved.status).toBe('solved')
    expect(solved.dof).toBe(0)

    doc = run(doc, 'add_to_sketch', { sketch: 's', constraints: [{ kind: 'length', line: 'r_bottom', value: 30 }] })
    k.build(doc)
    solved = await query(doc, k, 'solve_sketch', { name: 's' })
    expect(solved.ok).toBe(false)
    expect(solved.status).toBe('conflict')
    expect(solved.message).toMatch(/#5 length r_bottom = 40/)
    expect(solved.constraints.some((c: string) => c.includes('CONFLICT'))).toBe(true)

    // Unconstrained polygon: DOF and a hint.
    doc = run(doc, 'sketch', { name: 'free', plane: 'XY' })
    doc = run(doc, 'add_to_sketch', { sketch: 'free', shapes: [{ kind: 'polygon', prefix: 't', points: [[0, 0], [10, 0], [5, 8]] }] })
    k.build(doc)
    const free = await query(doc, k, 'solve_sketch', { name: 'free' })
    expect(free.dof).toBe(6)
    expect(free.hint).toMatch(/degree/)

    expect(() => run(doc, 'add_to_sketch', { sketch: 'nope', shapes: [] })).toThrow(/no sketch "nope"; sketches are: s, free/)
    expect(() => run(doc, 'extrude', { name: 'x', sketch: 'missing', distance: 1 })).toThrow(/sketch "missing" does not exist/)
  }, 60_000)

  it('makes plates with holes and slots, and revolves profiles', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'sketch', { name: 'plate', plane: 'XY' })
    doc = run(doc, 'add_to_sketch', {
      sketch: 'plate',
      shapes: [
        { kind: 'rect', prefix: 'outer', w: 60, h: 40 },
        { kind: 'circle', prefix: 'h1', r: 3, center: [-20, 0] },
        { kind: 'slot', prefix: 's1', length: 20, width: 6, center: [10, 0] },
      ],
    })
    const k = new Kernel()
    k.build(doc)
    const sk = await query(doc, k, 'solve_sketch', { name: 'plate' })
    expect(sk.status).toBe('solved')
    expect(sk.dof).toBe(0)
    expect(sk.loops).toHaveLength(3)

    doc = run(doc, 'extrude', { name: 'plate_body', sketch: 'plate', distance: 2 })
    const st = k.build(doc).features.find((f) => f.name === 'plate_body')!
    expect(st.error).toBeUndefined()
    const slotArea = 14 * 6 + Math.PI * 9
    expect(st.volume).toBeCloseTo((2400 - Math.PI * 9 - slotArea) * 2, 2)

    // Revolve a washer cross-section about Z.
    doc = run(doc, 'sketch', { name: 'ring', plane: 'XZ' })
    doc = run(doc, 'add_to_sketch', { sketch: 'ring', shapes: [{ kind: 'rect', prefix: 'sec', w: 5, h: 2, center: [7.5, 1] }] })
    doc = run(doc, 'revolve', { name: 'washer', sketch: 'ring', axis: 'Z' })
    const w = k.build(doc).features.find((f) => f.name === 'washer')!
    expect(w.error).toBeUndefined()
    expect(w.volume).toBeCloseTo(Math.PI * (100 - 25) * 2, 2)

    doc = run(doc, 'revolve', { name: 'bad', sketch: 'ring', axis: 'Y' })
    const bad = k.build(doc).features.find((f) => f.name === 'bad')!
    expect(bad.error).toMatch(/axis Y is not in the XZ plane/)
  }, 60_000)
})
