import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { fabFiles } from '../src/engine/pcb/fab'
import { panelize } from '../src/engine/pcb/panel'
import './setup'

async function run(doc: Doc, k: Kernel, cmd: string, args: unknown): Promise<Doc> {
  const def = command(cmd)!
  let a = parseArgs(def, args)
  if (def.prepare) a = await def.prepare({ doc, kernel: localKernel(k, doc) }, a as never)
  return applyOp(doc, { cmd, args: a }).doc
}

async function small(k: Kernel) {
  let doc = await run(emptyDoc(), k, 'set_board', { outline: { rect: { w: 20, h: 10 } } })
  doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R1', at: [-3, 0] })
  doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R2', at: [3, 0] })
  doc = await run(doc, k, 'connect', { nets: [{ name: 'A', pins: ['R1.2', 'R2.1'] }] })
  doc = await run(doc, k, 'add_track', { net: 'A', layer: 'F.Cu', points: [[-2.175, 0], [2.175, 0]] })
  doc = await run(doc, k, 'add_mounting_hole', { holes: [{ at: [8, 3], d: 2 }] })
  k.build(doc)
  return doc
}

describe('panelize', () => {
  it('V-score 3 × 2 with rails: copies, outline, V-cuts, tooling holes, fiducials, panel BOM/CPL', async () => {
    const k = new Kernel()
    const doc = await small(k)
    const st = k.boardState(doc)!
    const p = panelize(doc.pcb!, st.board, st.zones, st.teardrops, { nx: 3, ny: 2, method: 'vscore' })
    expect([p.width, p.height]).toEqual([60, 30])
    expect(p.board.components.length).toBe(12)
    expect(p.pcb.tracks.length).toBe(6)
    // Board (i, j) copy of R1 sits at its offset: board 2 (i = 1) is 20 mm to the right of board 1.
    const r1 = p.board.components.filter((c) => c.ref.startsWith('R1_')).map((c) => [c.at.x, c.at.y])
    expect(r1[1][0] - r1[0][0]).toBeCloseTo(20, 6)
    // Inner cuts at x = 20, 40 and y = 5 + 10, plus the rail lines y = 5, 25.
    expect(p.vscore.length).toBe(2 + 3)
    const files = fabFiles(p.pcb, p.board, p.zones, p.teardrops)
    expect(files['board-V_Cut.gm2']).toContain('TF.FileFunction,Vcut')
    expect(files['cpl.csv'].split('\n').filter((l) => l.startsWith('"R1_')).length).toBe(6)
    expect(files['bom.csv']).toContain('R1_1,R2_1,R1_2')
    // Tooling holes in the rails, and each board's own hole: 4 + 6.
    expect(files['board-NPTH.drl'].match(/^X/gm)!.length).toBe(4 + 6)
    // 3 fiducials on each side.
    expect(p.board.pads.filter((x) => x.ref.startsWith('FID')).length).toBe(6)
    expect(p.pcb.nets[0].pins.length).toBe(12)
  }, 60_000)

  it('mouse bites: gaps, milled outlines and tab holes', async () => {
    const k = new Kernel()
    const doc = await small(k)
    const st = k.boardState(doc)!
    const p = panelize(doc.pcb!, st.board, st.zones, st.teardrops, { nx: 2, ny: 1, method: 'mousebite', gap: 2 })
    // Rails top and bottom with a milling gap to the boards: 2 × (5 + 2) + 10.
    expect([p.width, p.height]).toEqual([42, 24])
    // Every tab hole is inside the panel and clear of both boards.
    const boards = p.board.components.filter((c) => c.ref.startsWith('R1_')).map((c) => c.at.x)
    expect(boards.length).toBe(2)
    for (const h of p.board.holes.filter((x) => x.d === 0.5)) {
      expect(h.at.x).toBeGreaterThan(0)
      expect(h.at.x).toBeLessThan(42)
      expect(h.at.y).toBeGreaterThan(5)
      expect(h.at.y).toBeLessThan(19)
      const inBoard = (x0: number) => h.at.x > x0 && h.at.x < x0 + 20 && h.at.y > 7 && h.at.y < 17
      expect(inBoard(0) || inBoard(22)).toBe(false)
    }
    const files = fabFiles(p.pcb, p.board, p.zones, p.teardrops)
    // Panel outline plus both boards'.
    expect((files['board-Edge_Cuts.gm1'].match(/D02\*/g) ?? []).length).toBe(3)
    expect(files['board-V_Cut.gm2']).toBeUndefined()
    // Tab rows: 2 to the rails per board, 1 between the boards = 5 rows × 5 bites, + 4 tooling + 2 board holes.
    expect(files['board-NPTH.drl'].match(/^X/gm)!.length).toBe(25 + 4 + 2)
  }, 60_000)

  it('refuses what does not fit the method', async () => {
    const k = new Kernel()
    let doc = await small(k)
    const st = k.boardState(doc)!
    expect(() => panelize(doc.pcb!, st.board, st.zones, st.teardrops, { nx: 2, ny: 2, method: 'vscore', gap: 2 })).toThrow(/no gap/)
    expect(() => panelize(doc.pcb!, st.board, st.zones, st.teardrops, { nx: 2, ny: 2, method: 'mousebite', gap: 1 })).toThrow(/at least 1.6/)
    doc = await run(doc, k, 'set_board', { outline: { rect: { w: 20, h: 10, r: 2 } } })
    k.build(doc)
    const st2 = k.boardState(doc)!
    expect(() => panelize(doc.pcb!, st2.board, st2.zones, st2.teardrops, { nx: 2, ny: 2, method: 'vscore' })).toThrow(/plain rectangle/)
    const files: string[] = []
    const def = command('export_fab')!
    const r = (await def.run!({ doc, kernel: localKernel(k, doc), download: async (n) => (files.push(n), n) }, parseArgs(def, { force: true, panel: { nx: 2, ny: 2, method: 'mousebite' } }) as never)) as any
    expect(files).toEqual(['board-panel-2x2.zip'])
    expect(r.panel.boards).toBe(4)
  }, 60_000)
})
