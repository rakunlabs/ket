import { describe, expect, it } from 'vitest'

import { type Doc, applyOp, command, emptyDoc, parseArgs } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import './setup'

function run(doc: Doc, cmd: string, args: unknown): Doc {
  return applyOp(doc, { cmd, args: parseArgs(command(cmd)!, args) }).doc
}

function checks(doc: Doc) {
  const k = new Kernel()
  const b = k.build(doc)
  expect(b.features.filter((f) => !f.ok).map((f) => f.error)).toEqual([])
  return k.checks(doc)
}

describe('overhang check', () => {
  it('passes a block on the plate and finds a shelf in the air', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'block', size: [20, 20, 10] })
    doc = run(doc, 'box', { name: 'post', size: [4, 4, 20] })
    doc = run(doc, 'box', { name: 'shelf', size: [20, 4, 2], translate: [8, 0, 18] })
    doc = run(doc, 'boolean', { name: 'tee', op: 'union', target: 'post', tools: ['shelf'] })
    doc = run(doc, 'set_checks', {
      checks: [
        { name: 'block_ok', kind: 'overhang', target: 'block' },
        { name: 'tee_over', kind: 'overhang', target: 'tee' },
        { name: 'tee_allowed', kind: 'overhang', target: 'tee', max_area: 100 },
        { name: 'tee_upside_down', kind: 'overhang', target: 'tee', axis: '-Z' },
      ],
    })
    const [block, tee, allowed, flipped] = checks(doc)
    expect(block.ok).toBe(true)
    expect(tee.ok).toBe(false)
    // The shelf's underside beyond the post: 20 × 4 minus the 2 × 4 over the post... the post top is inside, so 16 × 4.
    expect(tee.detail).toMatch(/^6[34]\.\d\d mm² overhangs more than 45° printing \+Z/)
    expect(allowed.ok).toBe(true)
    // Upside down the shelf lies on the plate and the post stands on it.
    expect(flipped.ok).toBe(true)
  }, 60_000)

  it('treats a 45° chamfer as printable and a 30° one as not', () => {
    let doc = emptyDoc()
    doc = run(doc, 'extrude', { name: 'ramp45', plane: 'XZ', profile: { kind: 'polygon', points: [[0, 0], [10, 0], [20, 10], [0, 10]] }, distance: 10 })
    doc = run(doc, 'extrude', { name: 'ramp30', plane: 'XZ', profile: { kind: 'polygon', points: [[0, 0], [10, 0], [27.32, 10], [0, 10]] }, distance: 10, translate: [0, 30, 0] })
    doc = run(doc, 'set_checks', { checks: [{ name: 'a', kind: 'overhang', target: 'ramp45' }, { name: 'b', kind: 'overhang', target: 'ramp30' }] })
    const [a, b] = checks(doc)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(false)
  }, 60_000)
})

describe('min_wall check', () => {
  it('finds walls thinner than the limit and passes thick ones', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'thin_box', size: [30, 20, 15] })
    doc = run(doc, 'shell', { name: 'thin', target: 'thin_box', thickness: 0.8 })
    doc = run(doc, 'box', { name: 'thick_box', size: [30, 20, 15], translate: [50, 0, 0] })
    doc = run(doc, 'shell', { name: 'thick', target: 'thick_box', thickness: 2 })
    doc = run(doc, 'set_checks', { checks: [{ name: 'thin_wall', kind: 'min_wall', target: 'thin', min: 1.2 }, { name: 'thick_wall', kind: 'min_wall', target: 'thick', min: 1.2 }] })
    const [thin, thick] = checks(doc)
    expect(thin.ok).toBe(false)
    expect(thin.detail).toMatch(/walls thinner than 1.2 mm: 0.8 mm in/)
    expect(thin.detail).toMatch(/approximate/)
    expect(thick.ok).toBe(true)
  }, 60_000)

  it('works on triangle-mesh bodies too', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'plate', size: [20, 20, 0.6] })
    doc = run(doc, 'set_checks', { checks: [{ name: 'w', kind: 'min_wall', target: 'plate', min: 1 }] })
    const [w] = checks(doc)
    expect(w.ok).toBe(false)
    expect(w.detail).toMatch(/0.6 mm/)
  }, 60_000)
})
