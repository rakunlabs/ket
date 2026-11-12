import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
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

describe('route_leg', () => {
  it('goes straight when clear and around an obstacle when not', async () => {
    const k = new Kernel()
    let doc = await run(emptyDoc(), k, 'set_board', { outline: { rect: { w: 40, h: 20 } } })
    doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R1', at: [-12, 0] })
    doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R2', at: [12, 0] })
    doc = await run(doc, k, 'add_component', { footprint_name: 'soic8', ref: 'U1', at: [0, 0] })
    doc = await run(doc, k, 'connect', { nets: [{ name: 'A', pins: ['R1.2', 'R2.1'] }, { name: 'B', pins: ['U1.1', 'U1.8'] }, { name: 'C', pins: ['U1.4', 'U1.5'] }] })
    k.build(doc)
    const b = k.boardState(doc)!.board
    const p1 = b.pads.find((p) => p.ref === 'R1' && p.pin === '2')!.center
    const p2 = b.pads.find((p) => p.ref === 'R2' && p.pin === '1')!.center
    const free = await query(doc, k, 'route_leg', { net: 'A', layer: 'F.Cu', a: [p1.x, 5], b: [p2.x, 5] })
    expect(free.straight).toBe(true)
    // Straight across U1's pin 2 / pin 7 row (y = 0.635): around them.
    doc = await run(doc, k, 'move_component', { moves: [{ ref: 'R1', at: [-12, 0.635] }, { ref: 'R2', at: [12, 0.635] }] })
    k.build(doc)
    const q1 = k.boardState(doc)!.board.pads.find((p) => p.ref === 'R1' && p.pin === '2')!.center
    const q2 = k.boardState(doc)!.board.pads.find((p) => p.ref === 'R2' && p.pin === '1')!.center
    const leg = await query(doc, k, 'route_leg', { net: 'A', layer: 'F.Cu', a: [q1.x, q1.y], b: [q2.x, q2.y] })
    expect(leg.ok).toBe(true)
    expect(leg.straight).toBe(false)
    expect(leg.points[0]).toEqual([q1.x, q1.y])
    expect(leg.points.at(-1)).toEqual([q2.x, q2.y])
    // Commit it: DRC is clean and the net is routed.
    doc = await run(doc, k, 'add_track', { net: 'A', layer: 'F.Cu', points: leg.points })
    k.build(doc)
    const drc = await query(doc, k, 'run_drc')
    expect(drc.violations.filter((v: any) => ['clearance', 'short'].includes(v.rule))).toEqual([])
    expect(k.boardState(doc)!.ratsnest.unrouted).not.toContain('A')
    // Every corner is 0/45/90°.
    for (let i = 1; i < leg.points.length; i++) {
      const [dx, dy] = [leg.points[i][0] - leg.points[i - 1][0], leg.points[i][1] - leg.points[i - 1][1]]
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI
      expect(Math.abs(ang / 45 - Math.round(ang / 45))).toBeLessThan(0.02)
    }
  }, 60_000)

  it('says when there is no way', async () => {
    const k = new Kernel()
    let doc = await run(emptyDoc(), k, 'set_board', { outline: { rect: { w: 40, h: 20 } } })
    doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R1', at: [-12, 0] })
    doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R2', at: [12, 0] })
    doc = await run(doc, k, 'connect', { nets: [{ name: 'A', pins: ['R1.2', 'R2.1'] }] })
    doc = await run(doc, k, 'add_keepout', { name: 'wall', rect: { at: [0, 0], w: 2, h: 20 }, forbid: ['tracks'] })
    k.build(doc)
    const r = await query(doc, k, 'route_leg', { net: 'A', layer: 'F.Cu', a: [-11, 0], b: [11, 0] })
    expect(r.ok).toBe(false)
    expect(r.note).toMatch(/another layer/)
  }, 60_000)
})
