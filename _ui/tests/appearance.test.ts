import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, summarize, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'

import './setup'

const run = (doc: Doc, cmd: string, args: unknown): Doc => applyOp(doc, { cmd, args }).doc

describe('text feature', () => {
  it('extrudes lettering with the cap height as size, centered on at', () => {
    let doc = emptyDoc()
    doc = run(doc, 'text', { name: 'label', text: 'KET', size: 5, depth: 1, plane: 'XY', offset: 2, at: [10, 0] })
    const f = new Kernel().build(doc).features[0]
    expect(f.ok, f.error).toBe(true)
    const [[x0, y0, z0], [x1, y1, z1]] = f.bbox!
    expect(z0).toBeCloseTo(2, 3)
    expect(z1).toBeCloseTo(3, 3)
    expect(y1 - y0).toBeCloseTo(5, 0)
    expect((x0 + x1) / 2).toBeCloseTo(10, 0)
    expect(f.volume!).toBeGreaterThan(5)
  })

  it('engraves into a body and anchors left', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'plate', size: [40, 20, 3] })
    doc = run(doc, 'text', { name: 'sn', text: 'SN 42', size: 3, depth: -0.5, plane: 'XY', offset: 3, at: [-15, 0], anchor: 'left', font: 'bold' })
    doc = run(doc, 'boolean', { name: 'plate_sn', op: 'cut', target: 'plate', tools: ['sn'] })
    const r = new Kernel().build(doc)
    const sn = r.features.find((f) => f.name === 'sn')!
    expect(sn.bbox![0][0]).toBeCloseTo(-15, 0)
    const cut = r.features.find((f) => f.name === 'plate_sn')!
    expect(cut.ok, cut.error).toBe(true)
    expect(cut.volume!).toBeLessThan(40 * 20 * 3)
    expect(cut.warnings).toBeUndefined()
  })
})

describe('materials and decals', () => {
  it('creates a material from a preset, assigns it and passes it to the mesh', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'case', size: [20, 10, 5] })
    doc = run(doc, 'set_material', { name: 'alu', preset: 'aluminum', roughness: 0.3, maps: { normal: { pattern: 'brushed', strength: 0.4 } } })
    doc = run(doc, 'assign_material', { names: ['case'], material: 'alu' })
    const m = doc.materials![0]
    expect(m.metalness).toBe(0.9)
    expect(m.roughness).toBe(0.3)
    // Preset maps stay, the given one replaces its kind.
    expect(m.maps!.roughness!.pattern).toBe('noise')
    expect(m.maps!.normal!.pattern).toBe('brushed')
    const k = new Kernel()
    const b = k.build(doc)
    const mesh = k.meshes(b)[0]
    expect(mesh.material?.name).toBe('alu')
    expect(b.appearance).toBeUndefined()
  })

  it('rejects unknown materials and bad maps with a clear message', () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'case', size: [20, 10, 5] })
    expect(() => run(doc, 'assign_material', { names: ['case'], material: 'nope' })).toThrow(/no material "nope".*set_material/)
    expect(() => run(doc, 'set_material', { name: 'x', color: '#fff', maps: { normal: { pattern: 'noise', image: 'a.png' } } })).toThrow()
  })

  it('adds decals, resolves expressions and follows renames and deletes', () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'h', expr: 5 }] })
    doc = run(doc, 'box', { name: 'keys', size: [20, 10, 'h'] })
    doc = run(doc, 'add_decals', {
      defaults: { target: 'keys', normal: [0, 0, 1], size: [8, 8], color: '#ffffff', font_size: 3 },
      decals: [
        { name: 'k_a', text: 'A', at: [-5, 0, 'h'] },
        { name: 'k_b', text: 'B', at: [5, 0, 'h'] },
      ],
    })
    expect(doc.decals).toHaveLength(2)
    const k = new Kernel()
    const mesh = k.meshes(k.build(doc))[0]
    expect(mesh.decals).toHaveLength(2)
    expect(mesh.decals![0].at).toEqual([-5, 0, 5])
    expect(mesh.decals![0].font_size).toBe(3)

    doc = run(doc, 'rename_feature', { name: 'keys', to: 'keycaps' })
    expect(doc.decals!.every((d) => d.target === 'keycaps')).toBe(true)
    doc = run(doc, 'delete_features', { names: ['keycaps'] })
    expect(doc.decals).toHaveLength(0)
  })

  it('reports decals on consumed bodies', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'a', size: [10, 10, 10] })
    doc = run(doc, 'add_decal', { name: 'logo', target: 'a', at: [0, 0, 10], normal: [0, 0, 1], size: [5, 5], text: 'X' })
    doc = run(doc, 'fillet', { name: 'a_round', target: 'a', r: 1 })
    const k = new Kernel()
    const b = k.build(doc)
    expect(b.appearance?.[0]).toMatch(/decal "logo": "a" is not a visible body/)
    const s = summarize(doc, b) as { appearance_problems?: string[] }
    expect(s.appearance_problems).toHaveLength(1)
    const def = command('run_checks')!
    const rc = (await def.run!({ doc, kernel: localKernel(k, doc) }, parseArgs(def, {}) as never)) as { appearance_problems?: string[] }
    expect(rc.appearance_problems).toHaveLength(1)
  })
})
