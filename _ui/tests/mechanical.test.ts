import { describe, expect, it } from 'vitest'

import { type Doc, applyOp, command, emptyDoc, parseArgs } from '../src/engine'
import { SCREWS } from '../src/engine/fasteners'
import { Kernel } from '../src/engine/kernel'
import './setup'

function run(doc: Doc, cmd: string, args: unknown): Doc {
  return applyOp(doc, { cmd, args: parseArgs(command(cmd)!, args) }).doc
}

function build(doc: Doc) {
  const k = new Kernel()
  const b = k.build(doc)
  return { k, b, f: (n: string) => b.features.find((x) => x.name === n)! }
}

const plate = () => run(emptyDoc(), 'box', { name: 'plate', size: [40, 30, 6] })

describe('hole', () => {
  it('drills plain through holes at the normal clearance diameter', () => {
    const doc = run(plate(), 'hole', { name: 'holes', target: 'plate', face: { where: '>Z' }, at: [[-10, 0], [10, 0]], size: 'M3' })
    const { f } = build(doc)
    expect(f('holes').ok).toBe(true)
    const r = SCREWS.M3.normal / 2
    expect(f('holes').volume).toBeCloseTo(40 * 30 * 6 - 2 * Math.PI * r * r * 6, 1)
  })

  it('counterbores and countersinks for the head, and stops at depth', () => {
    const base = 40 * 30 * 6
    const cb = build(run(plate(), 'hole', { name: 'h', target: 'plate', face: { where: '>Z' }, at: [[0, 0]], kind: 'counterbore', size: 'M3' })).f('h')
    const s = SCREWS.M3
    const rb = (s.head_d + 0.4) / 2
    const hb = s.head_h + 0.2
    expect(cb.volume).toBeCloseTo(base - Math.PI * rb * rb * hb - Math.PI * (s.normal / 2) ** 2 * (6 - hb), 1)

    const cs = build(run(plate(), 'hole', { name: 'h', target: 'plate', face: { where: '>Z' }, at: [[0, 0]], kind: 'countersink', size: 'M3' })).f('h')
    // Cone from the head radius down to the hole radius (90°: its height is the radius difference).
    const R1 = s.csk_d / 2
    const r = s.normal / 2
    const hc = R1 - r
    const coneVol = (Math.PI * hc * (R1 * R1 + R1 * r + r * r)) / 3
    expect(cs.volume).toBeCloseTo(base - coneVol - Math.PI * r * r * (6 - hc), 1)

    const blind = build(run(plate(), 'hole', { name: 'h', target: 'plate', face: { where: '>Z' }, at: [[0, 0]], kind: 'tapped', size: 'M3', depth: 4 })).f('h')
    expect(blind.volume).toBeCloseTo(base - Math.PI * (s.tap / 2) ** 2 * 4, 1)
  })

  it('works on a side face and warns when it misses', () => {
    const side = build(run(plate(), 'hole', { name: 'h', target: 'plate', face: { where: '>X' }, at: [[0, 0]], d: 2, depth: 5 })).f('h')
    expect(side.volume).toBeCloseTo(40 * 30 * 6 - Math.PI * 5, 1)
    const miss = build(run(plate(), 'hole', { name: 'h', target: 'plate', face: { where: '>Z' }, at: [[100, 0]], size: 'M3' })).f('h')
    expect(miss.warnings?.[0]).toMatch(/removed no material/)
  })

  it('needs a head size for a counterbore', () => {
    const f = build(run(plate(), 'hole', { name: 'h', target: 'plate', face: { where: '>Z' }, at: [[0, 0]], kind: 'counterbore', d: 3 })).f('h')
    expect(f.ok).toBe(false)
    expect(f.error).toMatch(/needs size/)
  })
})

describe('insert_boss', () => {
  it('adds bosses with insert holes on a floor', () => {
    let doc = run(emptyDoc(), 'box', { name: 'base', size: [40, 30, 2] })
    doc = run(doc, 'insert_boss', { name: 'bosses', target: 'base', face: { where: '>Z' }, at: [[-12, 0], [12, 0]], size: 'M3', height: 6 })
    const { f } = build(doc)
    expect(f('bosses').ok).toBe(true)
    expect(f('bosses').bbox![1][2]).toBeCloseTo(8, 6)
    expect(f('bosses').solids).toBe(1)
    // Hole 5.7 + 0.5 deep from the top of the boss (z = 8) ends at z = 1.8, inside the 2 mm floor.
    expect(f('bosses').warnings).toBeUndefined()
  })

  it('warns when the insert hole goes through', () => {
    let doc = run(emptyDoc(), 'box', { name: 'base', size: [40, 30, 2] })
    doc = run(doc, 'insert_boss', { name: 'bosses', target: 'base', face: { where: '>Z' }, at: [[0, 0]], size: 'M3', height: 2 })
    expect(build(doc).f('bosses').warnings?.join(' ')).toMatch(/goes through the part/)
  })
})

describe('thread', () => {
  it('makes an M6 rod and a hole tool slightly bigger', () => {
    let doc = run(emptyDoc(), 'thread', { name: 'rod', kind: 'external', size: 'M6', length: 10 })
    doc = run(doc, 'thread', { name: 'nut_tool', kind: 'internal', size: 'M6', length: 10, translate: [20, 0, 0] })
    const { f } = build(doc)
    expect(f('rod').ok).toBe(true)
    const [lo, hi] = f('rod').bbox!
    expect(hi[0] - lo[0]).toBeGreaterThan(5.8)
    expect(hi[0] - lo[0]).toBeLessThanOrEqual(6.01)
    expect(hi[2] - lo[2]).toBeCloseTo(10, 2)
    // Between the minor and the major cylinder.
    const rMin = 3 - (5 / 8) * 0.8660254
    expect(f('rod').volume).toBeGreaterThan(Math.PI * rMin * rMin * 10)
    expect(f('rod').volume).toBeLessThan(Math.PI * 9 * 10)
    expect(f('nut_tool').volume).toBeGreaterThan(f('rod').volume!)
  }, 60_000)
})

describe('draft', () => {
  it('tapers side walls from the bottom', () => {
    let doc = run(emptyDoc(), 'box', { name: 'cup', size: [20, 20, 10] })
    doc = run(doc, 'draft', { name: 'cup_draft', target: 'cup', faces: { where: '#Z' }, angle: 5 })
    const { f } = build(doc)
    expect(f('cup_draft').ok).toBe(true)
    // Bottom stays 20 × 20, the top narrows by 2·10·tan 5°: a frustum of a square pyramid.
    const a = 20
    const b = 20 - 2 * 10 * Math.tan((5 * Math.PI) / 180)
    expect(f('cup_draft').volume).toBeCloseTo((10 / 3) * (a * a + a * b + b * b), 2)
    const tilted = new Kernel()
    tilted.build(doc)
    const side = tilted.faces('cup_draft', { where: '>X' })[0]
    expect(side.normal![2]).toBeCloseTo(Math.sin((5 * Math.PI) / 180), 3)
  })
})

describe('snap_fit', () => {
  it('makes a hook and the matching window', () => {
    let doc = run(emptyDoc(), 'snap_fit', { name: 'hook', part: 'hook', length: 10, width: 6, thickness: 1.6, catch: 1, catch_length: 2 })
    doc = run(doc, 'snap_fit', { name: 'win', part: 'window', hook: 'hook', clearance: 0.3, wall: 2 })
    const { f } = build(doc)
    expect(f('hook').ok).toBe(true)
    expect(f('hook').bbox).toEqual([[0, -3, 0], [2.6, 3, 10]])
    expect(f('win').ok).toBe(true)
    const [wlo, whi] = f('win').bbox!
    // The window spans the catch: width + 2 × clearance, and the catch height + 2 × clearance.
    expect(whi[1] - wlo[1]).toBeCloseTo(6.6, 3)
    expect(whi[2] - wlo[2]).toBeCloseTo(2.6, 3)
    expect(wlo[2]).toBeCloseTo(7.7, 3)
    expect(whi[0]).toBeGreaterThan(2.6)
  })

  it('warns about a stiff hook', () => {
    const doc = run(emptyDoc(), 'snap_fit', { name: 'hook', part: 'hook', length: 4, thickness: 2.5, catch: 1.5 })
    expect(build(doc).f('hook').warnings?.join(' ')).toMatch(/strain/)
  })
})
