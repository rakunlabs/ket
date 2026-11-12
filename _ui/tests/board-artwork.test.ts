import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc, type Op } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { bitmapRegions, boardStyle, resolveArtwork, textRegions } from '../src/engine/pcb/artwork'
import { fabFiles } from '../src/engine/pcb/fab'
import { area } from '../src/engine/pcb/poly'
import { readProjectFile, writeProjectFile } from '../src/engine/project-file'
import { boardCopper, disposeCopper } from '../src/lib/board3d'

import './setup'

async function prepared(doc: Doc, cmd: string, args: unknown): Promise<Op> {
  const def = command(cmd)!
  let a = parseArgs(def, args)
  if (def.prepare) a = await def.prepare({ doc, kernel: localKernel(new Kernel(), doc) }, a as never)
  return { cmd, args: a }
}

async function run(doc: Doc, cmd: string, args: unknown): Promise<Doc> {
  return applyOp(doc, await prepared(doc, cmd, args)).doc
}

function board(doc: Doc, drc = false) {
  const kernel = new Kernel()
  kernel.build(doc)
  return kernel.boardState(doc, { drc })!
}

const ring = ['###', '#.#', '###']

describe('PCB colors and printed artwork', () => {
  it('keeps old boards green with white ink and supports all mask choices', async () => {
    let doc = await run(emptyDoc(), 'set_board', {})
    expect(boardStyle(doc.pcb!)).toMatchObject({ mask: 'green', silk: 'white' })
    for (const mask of ['green', 'black', 'white', 'blue', 'red', 'purple', 'yellow']) {
      doc = await run(doc, 'set_board_style', { mask, silk: 'black' })
      expect(doc.pcb!.style).toEqual({ mask, silk: 'black' })
    }
    doc = await run(doc, 'set_board_style', { mask: 'blue' })
    expect(doc.pcb!.style).toEqual({ mask: 'blue', silk: 'black' })
    const kernel = new Kernel()
    const build = kernel.build(doc)
    expect(kernel.meshes(build).find((mesh) => mesh.name === 'board')?.color).toBe('#1b467e')
    await expect(run(doc, 'set_board_style', { mask: 'orange' })).rejects.toThrow()
    await expect(run(emptyDoc(), 'set_board_style', { mask: 'blue' })).rejects.toThrow(/no board/)
  })

  it('converts logos to normalized polygons without filling their holes', () => {
    const regions = bitmapRegions(ring)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toHaveLength(2)
    expect(regions.flat(1).reduce((sum, poly) => sum + area(poly), 0)).toBeCloseTo(8 / 9)
    expect(() => bitmapRegions(['..'])).toThrow(/no printable pixels/)
    expect(() => bitmapRegions(['##', '#'])).toThrow(/rectangular/)
    expect(() => bitmapRegions(['XX'])).toThrow(/using #/)
    expect(() => bitmapRegions(['#'.repeat(257)])).toThrow(/256/)
  })

  it('prepares font outlines and replays editable project files without font or image I/O', async () => {
    const text = await textRegions('O')
    expect(text.some((region) => region.length > 1)).toBe(true)
    const ops: Op[] = [{ cmd: 'set_board', args: {} }]
    let doc = applyOp(emptyDoc(), ops[0]).doc
    ops.push(await prepared(doc, 'add_board_artwork', { name: 'label', text: 'Ket v1.0', at: [0, 5], width: 12 }))
    doc = applyOp(doc, ops[1]).doc
    ops.push(await prepared(doc, 'add_board_artwork', { name: 'logo', bitmap: ring, at: [0, -5], width: 4, side: 'bottom' }))
    doc = applyOp(doc, ops[2]).doc
    expect(readProjectFile(writeProjectFile(ops)).doc).toEqual(doc)
    const result = await command('get_board')!.run!({ doc, kernel: localKernel(new Kernel(), doc) }, {}) as any
    expect(result.style.mask).toBe('green')
    expect(result.artwork.map((a: { name: string }) => a.name)).toEqual(['label', 'logo'])
    expect(board(doc).board.artwork).toHaveLength(2)
    await expect(run(doc, 'add_board_artwork', { name: 'bad', text: 'A', bitmap: ['#'], at: [0, 0], width: 1 })).rejects.toThrow(/not both/)
  })

  it('preserves parametric placement, mirrors bottom artwork once and supports editing/removal', async () => {
    let doc = await run(emptyDoc(), 'set_board', {})
    doc = await run(doc, 'set_parameters', { parameters: [{ name: 'logo_w', expr: 6 }] })
    doc = await run(doc, 'add_board_artwork', { name: 'logo', bitmap: ['##', '#.'], at: [3, 4], width: 'logo_w' })
    const art = doc.pcb!.artwork![0]
    const top = resolveArtwork(art, new Map([['logo_w', 6]]))
    const bottom = resolveArtwork({ ...art, side: 'bottom' }, new Map([['logo_w', 6]]))
    top.regions[0][0].forEach((p, i) => {
      expect(bottom.regions[0][0][i].x).toBeCloseTo(6 - p.x)
      expect(bottom.regions[0][0][i].y).toBe(p.y)
    })
    const turned = resolveArtwork({ ...art, rotation: 90 }, new Map([['logo_w', 6]]))
    top.regions[0][0].forEach((p, i) => {
      expect(turned.regions[0][0][i].x).toBeCloseTo(3 - (p.y - 4))
      expect(turned.regions[0][0][i].y).toBeCloseTo(4 + (p.x - 3))
    })
    const original = JSON.stringify(doc)
    const moved = await run(doc, 'update_board_artwork', { name: 'logo', at: [-4, 3], side: 'bottom' })
    expect(JSON.stringify(doc)).toBe(original)
    expect(moved.pcb!.artwork![0].width).toBe('logo_w')
    expect(moved.pcb!.artwork![0].regions).toEqual(art.regions)
    await expect(run(doc, 'add_board_artwork', { name: 'logo', bitmap: ring, at: [0, 0], width: 2 })).rejects.toThrow(/already exists/)
    doc = await run(doc, 'add_board_artwork', { name: 'logo', text: 'NEW', at: [0, 0], width: 8, replace: true })
    expect(doc.pcb!.artwork![0].text).toBe('NEW')
    doc = await run(doc, 'remove_board_artwork', { names: ['logo'] })
    expect(doc.pcb!.artwork).toEqual([])
    await expect(run(doc, 'remove_board_artwork', { names: ['missing'] })).rejects.toThrow(/no board artwork/)
  })

  it('writes artwork only into its chosen Gerber legend layer, preserving holes and copper', async () => {
    let doc = await run(emptyDoc(), 'set_board', {})
    const before = fabFiles(doc.pcb!, board(doc).board)
    doc = await run(doc, 'add_board_artwork', { name: 'top_logo', bitmap: ring, at: [0, 0], width: 3 })
    let files = fabFiles(doc.pcb!, board(doc).board)
    expect(files['board-F_Silkscreen.gto']).toContain('G36*')
    expect(files['board-F_Silkscreen.gto'].match(/D02\*/g)).toHaveLength(2)
    expect(files['board-F_Silkscreen.gto']).not.toContain('%LPC*%')
    expect(files['board-B_Silkscreen.gbo']).toBe(before['board-B_Silkscreen.gbo'])
    expect(files['board-F_Cu.gtl']).toBe(before['board-F_Cu.gtl'])
    expect(files['board-F_Mask.gts']).toBe(before['board-F_Mask.gts'])
    doc = await run(doc, 'update_board_artwork', { name: 'top_logo', side: 'bottom' })
    files = fabFiles(doc.pcb!, board(doc).board)
    expect(files['board-F_Silkscreen.gto']).toBe(before['board-F_Silkscreen.gto'])
    expect(files['board-B_Silkscreen.gbo']).toContain('G36*')
  })

  it('checks artwork against exposed pads, board edges and drilled holes', async () => {
    let doc = await run(emptyDoc(), 'set_board', {})
    doc = await run(doc, 'add_component', { footprint_name: '0603', ref: 'R1', at: [0, 0] })
    doc = await run(doc, 'add_mounting_hole', { holes: [{ at: [6, 0], d: 2 }] })
    doc = await run(doc, 'add_board_artwork', { name: 'pad_logo', bitmap: ['#'], at: [0, 0], width: 3 })
    doc = await run(doc, 'add_board_artwork', { name: 'edge_logo', bitmap: ['#'], at: [24, 0], width: 3 })
    doc = await run(doc, 'add_board_artwork', { name: 'hole_logo', bitmap: ['#'], at: [6, 0], width: 1 })
    const rules = board(doc, true).drc!
    expect(rules.some((v) => v.rule === 'silk_to_pad' && v.objects?.includes('pad_logo'))).toBe(true)
    expect(rules.some((v) => v.rule === 'silk_to_edge' && v.objects?.includes('edge_logo'))).toBe(true)
    expect(rules.some((v) => v.rule === 'silk_to_hole' && v.objects?.includes('hole_logo'))).toBe(true)
    doc = await run(doc, 'update_board_artwork', { name: 'pad_logo', side: 'bottom' })
    expect(board(doc, true).drc!.some((v) => v.rule === 'silk_to_pad' && v.objects?.includes('pad_logo'))).toBe(false)
  })

  it('shows artwork on both 3D faces without leaking colors between projects', async () => {
    let doc = await run(emptyDoc(), 'set_board', {})
    doc = await run(doc, 'add_board_artwork', { name: 'top', bitmap: ring, at: [0, 0], width: 3 })
    doc = await run(doc, 'add_board_artwork', { name: 'bottom', bitmap: ring, at: [0, 0], width: 3, side: 'bottom' })
    const first = boardCopper(doc.pcb!, board(doc))
    const whiteInk = first.children.map((o) => (o as THREE.Mesh).material as THREE.MeshBasicMaterial)
    doc = await run(doc, 'set_board_style', { mask: 'white', silk: 'black' })
    const second = boardCopper(doc.pcb!, board(doc))
    expect(whiteInk.every((m) => m.color.getHexString() === 'f2f2ea')).toBe(true)
    expect(second.children.every((o) => ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHexString() === '20211e')).toBe(true)
    const boxes = second.children.map((o) => new THREE.Box3().setFromObject(o))
    expect(boxes.some((b) => b.min.z > 1.6)).toBe(true)
    expect(boxes.some((b) => b.max.z < 0)).toBe(true)
    disposeCopper(first); disposeCopper(second)
  })
})
