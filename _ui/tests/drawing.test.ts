import { describe, expect, it } from 'vitest'

import { type Ctx, type Doc, applyOp, command, emptyDoc, localKernel, parseArgs } from '../src/engine'
import { layoutSheet, pathsToLines, sheetDXF, sheetPDF, sheetSVG } from '../src/engine/drawing'
import { Kernel } from '../src/engine/kernel'
import './setup'

function run(doc: Doc, cmd: string, args: unknown): Doc {
  return applyOp(doc, { cmd, args: parseArgs(command(cmd)!, args) }).doc
}

async function query(doc: Doc, cmd: string, args: unknown = {}) {
  const files: { name: string; blob: Blob }[] = []
  const ctx: Ctx = { doc, kernel: localKernel(new Kernel(), doc), download: async (name, blob) => (files.push({ name, blob }), name) }
  const def = command(cmd)!
  const out = (await def.run!(ctx, parseArgs(def, args) as never)) as any
  return { out, files }
}

function part(): Doc {
  let doc = emptyDoc()
  doc = run(doc, 'box', { name: 'block', size: [60, 40, 20] })
  doc = run(doc, 'cylinder', { name: 'bore', r: 5, h: 30, translate: [0, 0, -5] })
  doc = run(doc, 'boolean', { name: 'bracket', op: 'cut', target: 'block', tools: ['bore'] })
  return doc
}

describe('pathsToLines', () => {
  it('reads lines, closes loops and samples arcs', () => {
    const [sq] = pathsToLines(['M 0 0 L 10 0 L 10 10 Z'], false)
    expect(sq).toEqual([[0, 0], [10, 0], [10, 10], [0, 0]])
    const [circle] = pathsToLines(['M 7 0 A 1 1 0 0 1 5 0 A 1 1 0 0 1 7 0 Z'], false)
    for (const [x, y] of circle) expect(Math.hypot(x - 6, y)).toBeCloseTo(1, 6)
    expect(circle.length).toBeGreaterThan(60)
  })
})

describe('drawing', () => {
  it('draws hidden-line views with the right sizes and dimensions', async () => {
    const { out, files } = await query(part(), 'drawing', { format: 'svg' })
    expect(out.views.map((v: any) => [v.name, v.size])).toEqual([
      ['front', [60, 20]],
      ['top', [60, 40]],
      ['right', [40, 20]],
      ['iso', expect.any(Array)],
    ])
    // The bore shows as hidden lines in front and right, and as a circle in top.
    expect(out.views.find((v: any) => v.name === 'front').hidden_lines).toBeGreaterThan(0)
    expect(out.dimensions).toEqual(['60', '20', '40'])
    // Front + top stacked (60 + 40 high) beside right + iso fits A4 at 1:1, not 2:1.
    expect(out.scale).toBe('1:1')
    expect(files[0].name).toBe('drawing.svg')
    const svg = await files[0].blob.text()
    expect(svg).toMatch(/^<\?xml/)
    expect(svg).toContain('class="h"')
    expect(svg).toContain('>FRONT<')
  }, 60_000)

  it('writes PDF and DXF', async () => {
    const pdf = await query(part(), 'drawing', { format: 'pdf', paper: 'A3' })
    const bytes = new Uint8Array(await pdf.files[0].blob.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    // The xref offsets point at the objects.
    const xref = Number(/startxref\n(\d+)/.exec(text)![1])
    expect(text.slice(xref, xref + 4)).toBe('xref')
    const first = Number(/0000000000 65535 f \n(\d{10})/.exec(text)![1])
    expect(text.slice(first, first + 7)).toBe('1 0 obj')

    const dxf = await query(part(), 'drawing', { format: 'dxf' })
    const d = await dxf.files[0].blob.text()
    expect(d).toContain('HIDDEN')
    expect(d.trimEnd().endsWith('EOF')).toBe(true)
  }, 60_000)

  it('refuses mesh bodies with a way out', async () => {
    const k = new Kernel()
    let doc = part()
    k.build(doc)
    expect(() => k.views(['nope'], ['front'])).toThrow(/no feature "nope"/)
  }, 60_000)
})

describe('layoutSheet', () => {
  it('aligns front with top (x) and with right (y)', () => {
    const v = (name: string, w: number, h: number) => ({ name, visible: [[[0, 0], [w, h]]] as [number, number][][], hidden: [], box: [[0, 0], [w, h]] as [[number, number], [number, number]] })
    const s = layoutSheet([v('front', 100, 30), v('top', 100, 50), v('right', 50, 30)], { title: 't' })
    const at = (n: string) => s.views.find((x) => x.name === n)!.at
    expect(at('front')[0]).toBeCloseTo(at('top')[0], 6)
    expect(at('front')[1]).toBeCloseTo(at('right')[1], 6)
    expect(at('top')[1]).toBeGreaterThan(at('front')[1])
    expect(s.scale).toBe(1)
    // Everything inside the sheet.
    for (const x of s.views) {
      expect(x.at[0]).toBeGreaterThan(0)
      expect(x.at[0] + x.box[1][0] * s.scale).toBeLessThan(s.width)
    }
    expect(sheetSVG(s)).toContain('1:1')
    expect(sheetPDF(s).length).toBeGreaterThan(500)
    expect(sheetDXF(s)).toContain('DIMENSIONS')
  })
})

describe('export_dxf', () => {
  it('writes a sketch outline with its holes', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'sketch', { name: 'panel', plane: 'XY' })
    doc = run(doc, 'add_to_sketch', { sketch: 'panel', shapes: [{ kind: 'rect', prefix: 'o', w: 100, h: 60 }, { kind: 'circle', prefix: 'h', r: 5, center: [20, 0] }] })
    const { out, files } = await query(doc, 'export_dxf', { sketch: 'panel' })
    expect(out.loops).toBe(2)
    expect(out.size).toEqual([100, 60])
    expect(out.area).toBeCloseTo(6000 - Math.PI * 25, 0)
    const d = await files[0].blob.text()
    expect(d.match(/POLYLINE/g)!.length).toBe(2)
    expect(d).toContain('CUT')
  }, 60_000)

  it('writes a face of a body in its own coordinates', async () => {
    const { out } = await query(part(), 'export_dxf', { feature: 'bracket', face: { where: '>Z' } })
    expect(out.loops).toBe(2)
    expect(out.size).toEqual([60, 40])
    expect(out.area).toBeCloseTo(2400 - Math.PI * 25, 0)
  }, 60_000)

  it('needs one source', () => {
    expect(() => parseArgs(command('export_dxf')!, {})).toThrow(/either sketch, or feature/)
    expect(() => parseArgs(command('export_dxf')!, { feature: 'x' })).toThrow(/needs face/)
  })
})
