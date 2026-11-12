import { describe, expect, it } from 'vitest'

import { type Doc, applyOp, bodies, command, emptyDoc, parseArgs } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import './setup'

function run(doc: Doc, cmd: string, args: unknown): Doc {
  return applyOp(doc, { cmd, args: parseArgs(command(cmd)!, args) }).doc
}

function feet(): Doc {
  let doc = emptyDoc()
  doc = run(doc, 'set_parameters', { parameters: [{ name: 'foot_h', expr: 5 }] })
  doc = run(doc, 'cylinder', { name: 'foot', r: 4, h: 'foot_h' })
  doc = run(doc, 'instance', { name: 'foot_2', of: 'foot', translate: [50, 0, 0] })
  doc = run(doc, 'instance', { name: 'foot_3', of: 'foot', translate: [0, 30, 0], rotate: [0, 0, 45] })
  return doc
}

describe('instance', () => {
  it('places copies and keeps the source a body', () => {
    const doc = feet()
    expect(bodies(doc).map((f) => f.name)).toEqual(['foot', 'foot_2', 'foot_3'])
    const k = new Kernel()
    const b = k.build(doc)
    const f = (n: string) => b.features.find((x) => x.name === n)!
    expect(f('foot').bbox).toEqual([[-4, -4, 0], [4, 4, 5]])
    expect(f('foot_2').bbox).toEqual([[46, -4, 0], [54, 4, 5]])
    expect(f('foot_3').volume).toBeCloseTo(f('foot').volume!, 3)
  })

  it('follows its source when it changes', () => {
    let doc = feet()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'foot_h', expr: 8 }] })
    const b = new Kernel().build(doc)
    expect(b.features.find((x) => x.name === 'foot_2')!.bbox![1][2]).toBe(8)
  })

  it('works with checks and boolean like any body', () => {
    let doc = feet()
    doc = run(doc, 'box', { name: 'base', size: [70, 50, 3], translate: [25, 15, 5] })
    doc = run(doc, 'set_checks', { checks: [{ name: 'apart', kind: 'min_distance', a: 'foot', b: 'foot_2', min: 30 }, { name: 'touch', kind: 'no_overlap', a: 'foot_2', b: 'base' }] })
    const k = new Kernel()
    k.build(doc)
    const [apart, touch] = k.checks(doc)
    expect(apart.ok).toBe(true)
    expect(apart.detail).toMatch(/42\.000/)
    expect(touch.ok).toBe(true)
    // Using an instance as a tool consumes the instance, not its source.
    doc = run(doc, 'boolean', { name: 'base_cut', op: 'cut', target: 'base', tools: ['foot_2'] })
    expect(bodies(doc).map((f) => f.name)).toEqual(['foot', 'foot_3', 'base_cut'])
  })

  it('is renamed and protected with its source', () => {
    let doc = feet()
    doc = run(doc, 'rename_feature', { name: 'foot', to: 'pad' })
    expect(doc.features.filter((f) => f.type === 'instance').map((f) => (f as { of: string }).of)).toEqual(['pad', 'pad'])
    expect(() => run(doc, 'delete_features', { names: ['pad'] })).toThrow(/foot_2 uses pad/)
  })

  it('exports one named STEP product per body', async () => {
    const k = new Kernel()
    const doc = feet()
    k.build(doc)
    const step = await (await k.export('step', ['foot', 'foot_2', 'foot_3'])).text()
    for (const n of ['foot', 'foot_2', 'foot_3']) expect(step).toContain(`PRODUCT('${n}'`)
  }, 60_000)
})
