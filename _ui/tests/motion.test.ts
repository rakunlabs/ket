import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { drivenPose, rotate } from '../src/engine/physics'

import './setup'

const run = (doc: Doc, cmd: string, args: unknown): Doc => applyOp(doc, { cmd, args }).doc
const q = async (doc: Doc, k: Kernel, cmd: string, args: unknown = {}) => {
  const def = command(cmd)!
  return def.run!({ doc, kernel: localKernel(k, doc) }, parseArgs(def, args) as never) as Promise<any>
}

describe('motion', () => {
  it('drives a gear train from its first gear rotation, with exact rates', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'crank', expr: 10 }] })
    doc = run(doc, 'gear', { name: 'a', kind: 'spur', teeth: 20, module: 2, width: 3, rotation: 'crank' })
    doc = run(doc, 'gear', { name: 'b', kind: 'spur', teeth: 40, module: 2, width: 3, mesh: { with: 'a' } })
    doc = run(doc, 'gear', { name: 'r', kind: 'rack', module: 2, width: 3, length: 60, mesh: { with: 'b', angle: 90 } })
    const k = new Kernel()
    const plan = await q(doc, k, 'get_motion')
    expect(plan.param).toBe('crank')
    expect(plan.base).toBe(10)
    const rate = (n: string) => plan.moves.find((m: any) => m.body === n)
    expect(rate('a').rate).toBeCloseTo(1, 9)
    expect(rate('b').rate).toBeCloseTo(-0.5, 9)
    expect(rate('b').origin[0]).toBeCloseTo(60, 6)
    // Rack: mm per degree of crank = b's degrees per crank × b's pitch radius in mm per degree.
    expect(Math.abs(rate('r').rate)).toBeCloseTo((0.5 * Math.PI * 40) / 180, 6)
    expect(rate('r').kind).toBe('slide')
  })

  it('poses a turning body about its own axis', () => {
    const p = drivenPose({ body: 'x', kind: 'rotate', axis: [0, 0, 1], origin: [10, 0, 0], rate: 2, from: 'joint' }, 45)
    // 90° about (10, 0): the point (20, 0) goes to (10, 10).
    const r = rotate(p.q, [20, 0, 0])
    expect(r[0] + p.t[0]).toBeCloseTo(10, 9)
    expect(r[1] + p.t[1]).toBeCloseTo(10, 9)
  })

  it('drops a loose ball onto a block and lets it settle', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'table', size: [60, 60, 10] })
    doc = run(doc, 'sphere', { name: 'ball', r: 5, translate: [0, 0, 40] })
    doc = run(doc, 'set_motion', { physics: { bodies: [{ name: 'ball', density: 7.8, restitution: 0.1 }] } })
    const k = new Kernel()
    const r = await q(doc, k, 'simulate', { seconds: 2, samples: 2 })
    const end = r.samples.at(-1).ball
    // Rests on the table top (z = 10) with its center about r above it.
    expect(end.center[2]).toBeGreaterThan(13.5)
    expect(end.center[2]).toBeLessThan(16)
    expect(end.moved).toBeGreaterThan(20)
  }, 60_000)

  it('carries a ball in a moving cup', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 't', expr: 0 }] })
    doc = run(doc, 'box', { name: 'cup_body', size: [24, 16, 8] })
    doc = run(doc, 'shell', { name: 'cup', target: 'cup_body', thickness: 1.6 })
    doc = run(doc, 'sphere', { name: 'ball', r: 4, translate: [0, 0, 6] })
    doc = run(doc, 'set_motion', {
      drive: { param: 't', speed: 1 },
      joints: [{ body: 'cup', kind: 'slide', axis: [1, 0, 0], rate: 10 }],
      physics: { bodies: [{ name: 'ball', density: 7.8, restitution: 0.1 }] },
    })
    const k = new Kernel()
    const r = await q(doc, k, 'simulate', { seconds: 3, samples: 3 })
    const end = r.samples.at(-1).ball.center
    // The cup moved 30 mm; the ball rolls to its back wall and rides inside (inner length 20.8 mm).
    expect(end[0]).toBeGreaterThan(30 - 10.5 - 1)
    expect(end[0]).toBeLessThan(30 + 10)
    expect(end[2]).toBeGreaterThan(4)
  }, 60_000)

  it('carries a ball in a slowly moving cup without kicking it out', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'crank', expr: 0 }] })
    doc = run(doc, 'box', { name: 'floor_plate', size: [260, 70, 4], translate: [-15, -15, -12] })
    doc = run(doc, 'box', { name: 'cup_body', size: [24, 16, 8], translate: [84, -9, 2.05] })
    doc = run(doc, 'shell', { name: 'cup', target: 'cup_body', thickness: 1.6 })
    doc = run(doc, 'sphere', { name: 'ball', r: 4, translate: [84, -9, 14] })
    doc = run(doc, 'set_motion', {
      drive: { param: 'crank', speed: 720 },
      joints: [{ body: 'cup', kind: 'slide', axis: [1, 0, 0], rate: -0.00524 }],
      physics: { bodies: [{ name: 'ball', density: 7.8, restitution: 0.3, friction: 0.4 }] },
    })
    const k = new Kernel()
    const r = await q(doc, k, 'simulate', { seconds: 6, samples: 12 })
    // The cup travels 720·6·0.00524 ≈ 22.6 mm in −x; the ball stays inside it.
    for (const [i, s] of r.samples.entries()) {
      const cupX = 84 - 0.00524 * 720 * s.t
      expect(Math.abs(s.ball.center[0] - cupX), `sample ${i}`).toBeLessThan(10.5)
      expect(s.ball.center[2], `sample ${i}`).toBeGreaterThan(5)
    }
  }, 60_000)

  it('drops a ball into a thin-walled cup from above and keeps it in', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'crank', expr: 0 }] })
    doc = run(doc, 'box', { name: 'floor_plate', size: [260, 70, 4], translate: [-15, -15, -12] })
    doc = run(doc, 'box', { name: 'cup_body', size: [24, 16, 8], translate: [84, -23, 4.1] })
    doc = run(doc, 'shell', { name: 'cup', target: 'cup_body', thickness: 1.6 })
    doc = run(doc, 'sphere', { name: 'ball', r: 4, translate: [84, -23, 16] })
    doc = run(doc, 'set_motion', {
      drive: { param: 'crank', speed: 720 },
      joints: [{ body: 'cup', kind: 'slide', axis: [1, 0, 0], rate: -0.005236 }],
      physics: { bodies: [{ name: 'ball', density: 7.8, restitution: 0.3, friction: 0.4 }] },
    })
    const r = await q(doc, new Kernel(), 'simulate', { seconds: 4, samples: 16 })
    for (const [i, s] of r.samples.entries()) {
      const cupX = 84 - 0.005236 * 720 * s.t
      // Inside the cup: floor top at 5.7, inner half-length 10.4, half-width 6.4.
      expect(s.ball.center[2], `z at sample ${i}`).toBeGreaterThan(5.7 + 3.5)
      expect(Math.abs(s.ball.center[0] - cupX), `x at sample ${i}`).toBeLessThan(10.4 - 3.5)
      expect(Math.abs(s.ball.center[1] + 23), `y at sample ${i}`).toBeLessThan(6.4 - 3.5)
    }
    expect(r.escaped).toBeUndefined()
  }, 60_000)

  it('reports a body that ends up inside a still solid', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'box', { name: 'block', size: [20, 20, 20] })
    // Starts inside the block: the watchdog must say so.
    doc = run(doc, 'sphere', { name: 'ball', r: 2, translate: [0, 0, 10] })
    doc = run(doc, 'set_motion', { physics: { bodies: [{ name: 'ball' }] } })
    const r = await q(doc, new Kernel(), 'simulate', { seconds: 0.1, samples: 1 })
    expect(r.escaped?.[0]).toMatch(/ball is inside "block"/)
  }, 60_000)

  it('rejects joints on missing bodies', () => {
    expect(() => run(emptyDoc(), 'set_motion', { joints: [{ body: 'nope', kind: 'rotate', axis: [0, 0, 1] }] })).toThrow(/no feature "nope"/)
  })
})
