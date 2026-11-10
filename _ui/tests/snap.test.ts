import { describe, expect, it } from 'vitest'

import { applyOp, emptyDoc, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { snapPoints } from '../src/lib/scene'

import './setup'

const run = (doc: Doc, cmd: string, args: unknown): Doc => applyOp(doc, { cmd, args }).doc
const has = (list: number[][], p: number[]) => list.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-3)

describe('ruler snapping and appearance', () => {
  it('finds corners, midpoints and hole centers', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'plate', size: [20, 10, 4] })
    doc = run(doc, 'cylinder', { name: 'hole_tool', r: 2, h: 10, translate: [5, 0, -1], hidden: true })
    doc = run(doc, 'boolean', { name: 'plate_holed', op: 'cut', target: 'plate', tools: ['hole_tool'] })
    const k = new Kernel()
    const r = k.build(doc)
    const m = k.meshes(r).find((x) => x.name === 'plate_holed')!
    expect(m.edgeGroups.length).toBeGreaterThan(0)
    const s = snapPoints(m)
    expect(has(s.vertex, [-10, -5, 0])).toBe(true)
    expect(has(s.vertex, [10, 5, 4])).toBe(true)
    expect(has(s.midpoint, [0, -5, 4])).toBe(true)
    expect(has(s.center, [5, 0, 4])).toBe(true)
    expect(has(s.center, [5, 0, 0])).toBe(true)
  })

  it('sets and resets color and opacity', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'case_body', size: [10, 10, 10] })
    doc = run(doc, 'set_appearance', { names: ['case_body'], color: '#C4372F', opacity: 0.3 })
    expect(doc.features[0]).toMatchObject({ color: '#c4372f', opacity: 0.3 })
    const k = new Kernel()
    expect(k.meshes(k.build(doc))[0].opacity).toBe(0.3)
    doc = run(doc, 'set_appearance', { names: ['case_body'], color: null, opacity: 1 })
    expect(doc.features[0].color).toBeUndefined()
    expect(doc.features[0].opacity).toBeUndefined()
    expect(() => run(doc, 'set_appearance', { names: ['nope'], opacity: 0.5 })).toThrow(/no feature "nope"/)
    expect(() => run(doc, 'set_appearance', { names: ['case_body'], color: 'red' })).toThrow(/#rrggbb/)
  })
})
