import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { area } from '../src/engine/pcb/poly'
import './setup'

async function run(doc: Doc, k: Kernel, cmd: string, args: unknown): Promise<Doc> {
  const def = command(cmd)!
  let a = parseArgs(def, args)
  if (def.prepare) a = await def.prepare({ doc, kernel: localKernel(k, doc) }, a as never)
  return applyOp(doc, { cmd, args: a }).doc
}

async function query(doc: Doc, k: Kernel, cmd: string, args: unknown = {}): Promise<any> {
  const def = command(cmd)!
  return def.run!({ doc, kernel: localKernel(k, doc) }, parseArgs(def, args) as never)
}

async function board(k: Kernel) {
  let doc = emptyDoc()
  doc = await run(doc, k, 'set_board', { outline: { rect: { w: 30, h: 20 } } })
  doc = await run(doc, k, 'add_component', { footprint_name: 'pinrow2', ref: 'J1', at: [-8, 0], rotation: 90 })
  doc = await run(doc, k, 'add_component', { footprint_name: 'pinrow2', ref: 'J2', at: [8, 0], rotation: 90 })
  doc = await run(doc, k, 'connect', { nets: [{ name: 'A', pins: ['J1.1', 'J2.1'] }] })
  k.build(doc)
  // A straight track from pin to pin, then a via in the middle with a track on to it.
  const b = k.boardState(doc)!.board
  const p1 = b.pads.find((p) => p.ref === 'J1' && p.pin === '1')!.center
  const p2 = b.pads.find((p) => p.ref === 'J2' && p.pin === '1')!.center
  doc = await run(doc, k, 'add_track', { net: 'A', layer: 'F.Cu', width: 0.25, points: [[p1.x, p1.y], [0, p1.y]] })
  doc = await run(doc, k, 'add_via', { net: 'A', at: [0, p1.y] })
  doc = await run(doc, k, 'add_track', { net: 'A', layer: 'B.Cu', width: 0.25, points: [[0, p1.y], [p2.x, p2.y]] })
  return doc
}

describe('teardrops', () => {
  it('are off until asked, then join tracks to pads and vias', async () => {
    const k = new Kernel()
    let doc = await board(k)
    k.build(doc)
    expect(k.boardState(doc)!.teardrops).toEqual([])
    doc = await run(doc, k, 'set_board', { teardrops: true })
    k.build(doc)
    const drops = k.boardState(doc)!.teardrops
    expect(drops.map((d) => d.joins).sort()).toEqual(['track 1 → J1.1', 'track 1 → via 1', 'track 2 → J2.1', 'track 2 → via 1'])
    for (const d of drops) expect(Math.abs(area(d.outline))).toBeGreaterThan(0.05)
    doc = await run(doc, k, 'set_board', { teardrops: false })
    expect(doc.pcb!.teardrops).toBeUndefined()
  }, 60_000)

  it('go into the Gerber and keep DRC clean', async () => {
    const k = new Kernel()
    let doc = await board(k)
    doc = await run(doc, k, 'set_board', { teardrops: { length: 1.2 } })
    k.build(doc)
    const drc = await query(doc, k, 'run_drc')
    expect(drc.violations.filter((v: any) => /teardrop/.test(v.message))).toEqual([])
    const fab = await query(doc, k, 'export_fab', { force: true })
    expect(fab.files).toContain('board-F_Cu.gtl')
    const { fabFiles } = await import('../src/engine/pcb/fab')
    const st = k.boardState(doc)!
    const without = fabFiles(doc.pcb!, st.board, st.zones)['board-F_Cu.gtl']
    const withDrops = fabFiles(doc.pcb!, st.board, st.zones, st.teardrops)['board-F_Cu.gtl']
    expect((withDrops.match(/G36\*/g) ?? []).length).toBe((without.match(/G36\*/g) ?? []).length + 2)
  }, 60_000)

  it('follow the copper they join and report clashes like copper', async () => {
    const k = new Kernel()
    let doc = await board(k)
    doc = await run(doc, k, 'set_board', { teardrops: true })
    // A foreign track right beside the via: the via's drop on F.Cu must not hide that clash, and DRC names the drop.
    doc = await run(doc, k, 'connect', { nets: [{ name: 'B', pins: ['J1.2', 'J2.2'] }] })
    const y = k.boardState(doc)!.board.pads.find((p) => p.ref === 'J1' && p.pin === '1')!.center.y
    doc = await run(doc, k, 'add_track', { net: 'B', layer: 'F.Cu', width: 0.25, points: [[-1.2, y + 0.55], [-0.2, y + 0.55]] })
    k.build(doc)
    const drc = await query(doc, k, 'run_drc')
    expect(drc.violations.some((v: any) => /teardrop \d+ \(track 1 → via 1\)/.test(v.message))).toBe(true)
  }, 60_000)
})
