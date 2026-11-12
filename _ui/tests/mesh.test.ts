import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { type TriMesh, mergeMeshes, read3MF, unzip, update3MF, write3MF, writeSTL, zipFiles } from '../src/engine/model-files'
import './setup'

function run(doc: Doc, cmd: string, args: unknown): Doc {
  return applyOp(doc, { cmd, args: parseArgs(command(cmd)!, args) }).doc
}

/** A closed box as triangles (outward), corner lo, size s. */
function boxMesh(lo: [number, number, number], s: [number, number, number]): TriMesh {
  const [x, y, z] = lo
  const [a, b, c] = s
  const v = [
    [x, y, z], [x + a, y, z], [x + a, y + b, z], [x, y + b, z],
    [x, y, z + c], [x + a, y, z + c], [x + a, y + b, z + c], [x, y + b, z + c],
  ]
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { positions: Float32Array.from(v.flat()), triangles: Uint32Array.from(t) }
}

/** A box whose faces are split into g × g squares: one closed solid with many triangles (past the B-rep STL limit). */
function denseBox(lo: [number, number, number], s: [number, number, number], g: number): TriMesh {
  const pos: number[] = []
  const tri: number[] = []
  // Each face: origin, two edge vectors (u × v points outward).
  const [x, y, z] = lo
  const [a, b, c] = s
  const faces: [number[], number[], number[]][] = [
    [[x, y, z], [0, b, 0], [a, 0, 0]],
    [[x, y, z + c], [a, 0, 0], [0, b, 0]],
    [[x, y, z], [a, 0, 0], [0, 0, c]],
    [[x, y + b, z], [0, 0, c], [a, 0, 0]],
    [[x, y, z], [0, 0, c], [0, b, 0]],
    [[x + a, y, z], [0, b, 0], [0, 0, c]],
  ]
  for (const [o, u, v] of faces) {
    const base = pos.length / 3
    for (let i = 0; i <= g; i++)
      for (let j = 0; j <= g; j++) for (let k = 0; k < 3; k++) pos.push(o[k] + (u[k] * i) / g + (v[k] * j) / g)
    for (let i = 0; i < g; i++)
      for (let j = 0; j < g; j++) {
        const p = base + i * (g + 1) + j
        tri.push(p, p + g + 1, p + g + 2, p, p + g + 2, p + 1)
      }
  }
  return { positions: Float32Array.from(pos), triangles: Uint32Array.from(tri) }
}

const buf = async (b: Blob) => b.arrayBuffer()

describe('mesh bodies (STL, 3MF)', () => {
  it('reads 3MF objects by id and name, in plate coordinates', async () => {
    const blob = await write3MF([
      { name: 'Cover', mesh: boxMesh([0, 0, 0], [10, 20, 5]) },
      { name: 'Pawn', mesh: boxMesh([30, 0, 0], [4, 4, 12]) },
    ])
    const files = unzip(await buf(blob))
    expect([...files.keys()]).toContain('3D/3dmodel.model')
    const f = await read3MF(await buf(blob))
    expect(f.objects.map((o) => o.name)).toEqual(['Cover', 'Pawn'])
    const pawn = await f.mesh(f.objects[1].id)
    expect(pawn.triangles.length).toBe(36)
    expect(Math.min(...pawn.positions.filter((_, i) => i % 3 === 0))).toBe(30)
  })

  it('cuts a pocket into a big STL mesh with a B-rep tool, checks and exports it', async () => {
    const k = new Kernel()
    const url = 'ket:asset/abc/cover.stl'
    let doc = emptyDoc()
    doc = run(doc, 'import', { name: 'cover', url })
    doc = run(doc, 'box', { name: 'pocket', size: [20, 10, 10], translate: [50, 10, 5] })
    doc = run(doc, 'boolean', { name: 'cover_cut', op: 'cut', target: 'cover', tools: ['pocket'] })
    expect(k.missingImports(doc)).toEqual([url])
    // 43 200 triangles: past the B-rep limit, so it stays a mesh.
    await k.loadImport(url, await buf(writeSTL([denseBox([0, 0, 0], [100, 20, 10], 60)])))
    const r = k.build(doc)
    const cover = r.features.find((f) => f.name === 'cover')!
    expect(cover.ok).toBe(true)
    expect(cover.triangles).toBeGreaterThan(20_000)
    expect(cover.volume).toBeCloseTo(20_000, 0)
    const cut = r.features.find((f) => f.name === 'cover_cut')!
    expect(cut.ok).toBe(true)
    expect(cut.warnings).toBeUndefined()
    // The pocket is 20 × 10 × 5 deep (the box is centered on X/Y and sits on z = 5).
    expect(cut.volume).toBeCloseTo(20_000 - 20 * 10 * 5, 0)
    expect(r.bodies).toEqual(['cover_cut'])

    const m = k.measure('cover_cut') as { size: number[]; triangles: number }
    expect(m.size).toEqual([100, 20, 10])

    doc = run(doc, 'box', { name: 'pawn', size: [6, 6, 4], translate: [50, 10, 7] })
    doc = run(doc, 'set_checks', {
      checks: [
        { kind: 'no_overlap', name: 'fits', a: 'pawn', b: 'cover_cut' },
        { kind: 'min_distance', name: 'clear', a: 'pawn', b: 'cover_cut', min: 1.5 },
      ],
    })
    k.build(doc)
    const checks = k.checks(doc)
    expect(checks.map((c) => c.ok)).toEqual([true, true])
    expect(checks[1].detail).toMatch(/= 2\.0+ mm/)

    // Selectors and fillets need B-rep: the error says what to do instead.
    doc = run(doc, 'fillet', { name: 'round', target: 'cover_cut', r: 1 })
    const bad = k.build(doc).features.find((f) => f.name === 'round')!
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/triangle mesh/)
    doc = run(doc, 'delete_features', { names: ['round'] })
    k.build(doc)

    const stl = await k.export('stl', ['cover_cut'])
    expect(stl.size).toBeGreaterThan(84)
    const threeMF = await read3MF(await buf(await k.export('3mf', ['cover_cut', 'pawn'])))
    expect(threeMF.objects.map((o) => o.name)).toEqual(['cover_cut', 'pawn'])
    await expect(k.export('step', ['cover_cut'])).rejects.toThrow(/STL or 3MF/)
  }, 120_000)

  it('takes one object of a 3MF by #name, patterns and mirrors meshes', async () => {
    const k = new Kernel()
    const file = 'ket:asset/xyz/set.3mf'
    let doc = emptyDoc()
    doc = run(doc, 'import', { name: 'pawn', url: `${file}#Pawn` })
    doc = run(doc, 'pattern', { name: 'row', target: 'pawn', kind: 'linear', count: 3, step: [10, 0, 0] })
    doc = run(doc, 'mirror', { name: 'both', target: 'row', plane: 'YZ' })
    // One fetch for the file, whatever objects are taken from it.
    expect(k.missingImports(doc)).toEqual([file])
    await k.loadImport(file, await buf(await write3MF([
      { name: 'Board', mesh: boxMesh([0, 0, 0], [50, 50, 2]) },
      { name: 'Pawn', mesh: denseBox([30, 0, 0], [4, 4, 12], 60) },
    ])))
    await k.prepareImports(doc)
    const r = k.build(doc)
    expect(r.features.every((f) => f.ok)).toBe(true)
    const both = r.features.find((f) => f.name === 'both')!
    expect(both.volume).toBeCloseTo(6 * 4 * 4 * 12, 0)
    expect(both.bbox![0][0]).toBeCloseTo(-54, 3)

    doc = run(emptyDoc(), 'import', { name: 'x', url: `${file}#Rook` })
    await k.prepareImports(doc)
    expect(k.build(doc).features[0].error).toMatch(/no object "Rook".*#\d+ \(Board\)/)
  }, 120_000)

  it('takes one solid of a set, lays it in a pocket with align and reads sections', async () => {
    const k = new Kernel()
    const url = 'ket:asset/set/set.stl'
    // Three "pieces" (dense, so they are meshes) standing on the plate; the middle one is tall.
    const set = mergeMeshes([denseBox([0, 0, 0], [6, 6, 10], 40), denseBox([20, 0, 0], [6, 6, 30], 40), denseBox([40, 0, 0], [6, 6, 15], 40)])
    await k.loadImport(url, await buf(writeSTL([set])))
    let doc = emptyDoc()
    doc = run(doc, 'import', { name: 'set', url })
    doc = run(doc, 'solids', { name: 'tall', source: 'set', pick: { near: [23, 3, 20] } })
    doc = run(doc, 'solids', { name: 'two_big', source: 'set', pick: { largest: 2 } })
    doc = run(doc, 'transform', { name: 'lying', target: 'tall', rotate: [0, 90, 0], align: { to: [100, 50, 2] } })
    const r = k.build(doc)
    expect(r.features.every((f) => f.ok)).toBe(true)
    // The source is not consumed: it stays a body.
    expect(r.bodies).toContain('set')
    expect(k.listSolids('set').map((s) => s.volume)).toEqual([360, 1080, 540])
    expect(r.features.find((f) => f.name === 'two_big')!.volume).toBeCloseTo(1620, 3)
    // Lying along X, its bottom center at [100, 50, 2].
    const lying = r.features.find((f) => f.name === 'lying')!.bbox!
    expect(lying[0]).toEqual([85, 47, 2])
    expect(lying[1]).toEqual([115, 53, 8])

    const [cut] = k.section(['set'], 'Z', 5) as { loops: { kind: string; area: number; box: number[][] }[]; area: number }[]
    expect(cut.loops.map((l) => [l.kind, l.area])).toEqual([['material', 36], ['material', 36], ['material', 36]])
    expect(cut.area).toBeCloseTo(108, 6)
    const [side] = k.section(['set'], 'Y', 3) as { loops: { box: number[][] }[] }[]
    // (x, z) outlines: the tall piece reaches z = 30.
    expect(Math.max(...side.loops.map((l) => l.box[1][1]))).toBe(30)
    const [miss] = k.section(['set'], 'Z', 40) as { cut: boolean }[]
    expect(miss.cut).toBe(false)

    // Deleting the source needs cascade: solids depends on it.
    expect(() => run(doc, 'delete_features', { names: ['set'] })).toThrow(/tall uses set/)
  }, 120_000)

  it('writes an edited object back into the slicer 3MF, keeping its frame, paint and the other files', async () => {
    // A slicer-style project: the object's mesh is in its own frame and moved by the build item; the top is painted.
    const local = denseBox([-50, -10, 0], [100, 20, 10], 40)
    const n = local.triangles.length / 3
    const paint = new Uint32Array(n)
    for (let t = 0; t < n; t++) {
      const z = (local.positions[local.triangles[t * 3] * 3 + 2] + local.positions[local.triangles[t * 3 + 1] * 3 + 2] + local.positions[local.triangles[t * 3 + 2] * 3 + 2]) / 3
      paint[t] = z > 9.99 ? 2 : 1
    }
    const meshXml = (m: TriMesh, p: Uint32Array) => {
      const v: string[] = []
      for (let i = 0; i < m.positions.length; i += 3) v.push(`<vertex x="${m.positions[i]}" y="${m.positions[i + 1]}" z="${m.positions[i + 2]}"/>`)
      const t: string[] = []
      for (let i = 0; i < m.triangles.length; i += 3) t.push(`<triangle v1="${m.triangles[i]}" v2="${m.triangles[i + 1]}" v3="${m.triangles[i + 2]}" paint_color="${p[i / 3] === 2 ? 8 : 4}"/>`)
      return `<mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh>`
    }
    const settings = '<config>printer: test</config>'
    const blob = await zipFiles({
      '_rels/.rels': '<Relationships><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      '3D/3dmodel.model': `<model unit="millimeter"><resources><object id="1" type="model">${meshXml(local, paint)}</object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 120 80 0"/></build></model>`,
      'Metadata/model_settings.config': '<config><object id="1"><metadata key="name" value="Tray"/><metadata face_count="' + n + '"/></object></config>',
      'Metadata/project_settings.config': settings,
    })
    const raw = new Uint8Array(await blob.arrayBuffer())
    const k = new Kernel()
    const url = 'ket:asset/t/tray.3mf'
    await k.loadImport(url, raw.buffer as ArrayBuffer)
    let doc = emptyDoc()
    doc = run(doc, 'import', { name: 'tray', url: `${url}#Tray` })
    doc = run(doc, 'box', { name: 'pocket', size: [20, 10, 10], translate: [120, 80, 5] })
    doc = run(doc, 'boolean', { name: 'tray_cut', op: 'cut', target: 'tray', tools: ['pocket'] })
    await k.prepareImports(doc)
    expect(k.build(doc).features.every((f) => f.ok)).toBe(true)

    const r = await k.update3MF(doc, [{ body: 'tray_cut', object: 'tray' }])
    expect(r.replaced).toEqual(['#1 (Tray)'])
    const files = unzip(await r.blob.arrayBuffer())
    expect(new TextDecoder().decode(await files.get('Metadata/project_settings.config')!())).toBe(settings)
    const back = await read3MF(await r.blob.arrayBuffer())
    const m = await back.mesh('1')
    // Still on the plate where it was: x 70..170, and the pocket is there.
    const xs = m.positions.filter((_, i) => i % 3 === 0)
    expect(Math.min(...xs)).toBeCloseTo(70, 3)
    expect(Math.max(...xs)).toBeCloseTo(170, 3)
    expect(m.paints).toContain('paint_color="8"')
    // Every triangle is painted; the pocket floor (z = 5, facing up) is new and takes a color.
    expect(m.paint!.every((p) => p > 0)).toBe(true)
    const cfg = new TextDecoder().decode(await files.get('Metadata/model_settings.config')!())
    expect(cfg).toContain(`face_count="${m.triangles.length / 3}"`)
  }, 120_000)

  it('says what is wrong with a mesh that is not closed', async () => {
    const k = new Kernel()
    const url = 'ket:asset/open/open.stl'
    const box = denseBox([0, 0, 0], [10, 10, 10], 60)
    const open = { positions: box.positions, triangles: box.triangles.slice(3) }
    await k.loadImport(url, await buf(writeSTL([open])))
    const doc = run(emptyDoc(), 'import', { name: 'broken', url })
    expect(k.build(doc).features[0].error).toMatch(/do not close into a solid/)
  }, 60_000)
})
