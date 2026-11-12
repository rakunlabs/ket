import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { planetarySets } from '../src/engine/mechanism-commands'
import { genevaAngle } from '../src/engine/mechanisms'
import { drivenPose, rotate } from '../src/engine/physics'

import './setup'

const run = (doc: Doc, cmd: string, args: unknown): Doc => applyOp(doc, { cmd, args }).doc
const q = async (doc: Doc, k: Kernel, cmd: string, args: unknown = {}) => {
  const def = command(cmd)!
  return def.run!({ doc, kernel: localKernel(k, doc) }, parseArgs(def, args) as never) as Promise<any>
}
const crank = (doc: Doc, v = 0) => run(doc, 'set_parameters', { parameters: [{ name: 'crank', expr: v }] })

describe('planetary', () => {
  it('finds sets that assemble', () => {
    const s = planetarySets(5, {})
    expect(s[0].ratio).toBeCloseTo(5, 9)
    for (const x of s.slice(0, 10)) {
      expect(x.ring).toBe(x.sun + 2 * x.planet)
      expect((x.sun + x.ring) % x.planets).toBe(0)
    }
  })

  it('places a set whose planets orbit at 1/ratio and spin correctly', async () => {
    let doc = crank(emptyDoc())
    doc = run(doc, 'planetary', { name: 'p', ratio: 4, module: 1, width: 6, bore: 3, rotation: 'crank' })
    const k = new Kernel()
    const b = k.build(doc)
    expect(b.features.filter((f) => !f.ok)).toEqual([])
    const { gears } = await q(doc, k, 'get_gears')
    const ring = gears.find((g: any) => g.name === 'p_ring')
    const sun = gears.find((g: any) => g.name === 'p_sun')
    // The ring lands on the sun's axis.
    expect(Math.hypot(ring.center[0] - sun.center[0], ring.center[1] - sun.center[1])).toBeLessThan(1e-6)
    expect(1 + ring.teeth / sun.teeth).toBeCloseTo(4, 9)
    expect(gears.flatMap((g: any) => g.warnings ?? [])).toEqual([])
    const plan = await q(doc, k, 'get_motion')
    const planet = plan.moves.find((m: any) => m.body === 'p_planet1')
    expect(planet.orbit.rate).toBeCloseTo(1 / 4, 6)
    const ringMove = plan.moves.find((m: any) => m.body === 'p_ring')
    // A fixed ring: it does not turn.
    expect(ringMove ? Math.abs(ringMove.rate) : 0).toBeLessThan(1e-6)
    const carrier = plan.moves.find((m: any) => m.body === 'p_carrier')
    expect(carrier.rate).toBeCloseTo(0.25, 4)
    // Posing the planet at crank 40 matches rebuilding the train at crank 40.
    const d = 40
    const pose = drivenPose(planet, d)
    const c0 = planet.origin
    const rc = rotate(pose.q, c0)
    const moved = [rc[0] + pose.t[0], rc[1] + pose.t[1]]
    const k2 = new Kernel()
    k2.build(crank(doc, 40))
    const g2 = (await q(crank(doc, 40), k2, 'get_gears')).gears.find((g: any) => g.name === 'p_planet1')
    expect(moved[0]).toBeCloseTo(g2.center[0], 2)
    expect(moved[1]).toBeCloseTo(g2.center[1], 2)
    // And the planet's own turn: a point on its +u axis.
    const u = rotate(pose.q, [1, 0, 0])
    const ang = (Math.atan2(u[1], u[0]) * 180) / Math.PI
    const g1 = gears.find((g: any) => g.name === 'p_planet1')
    const want = ((g2.rotation - g1.rotation) % 360 + 540) % 360 - 180
    expect(((ang - want) % 360 + 540) % 360 - 180).toBeCloseTo(0, 1)
    // No two parts of the set collide over part of a turn.
    const sw = await q(doc, k, 'sweep_motion', { from: 0, to: 30, steps: 3, bodies: ['p_sun', 'p_planet1', 'p_ring'] })
    expect(sw.collisions).toEqual([])
  }, 120_000)
})

describe('geneva', () => {
  it('indexes 360/slots per turn and dwells', () => {
    const k = Math.sin(Math.PI / 4)
    expect(genevaAngle(4, k, 180)).toBeCloseTo(-45, 9)
    expect(genevaAngle(4, k, 180 + 360)).toBeCloseTo(-135, 9)
    // Locked during the dwell: from 45° to 315° past the line of centers.
    expect(genevaAngle(4, k, 100)).toBeCloseTo(genevaAngle(4, k, 260), 9)
    // Continuous through the engagement.
    for (let t = -60; t < 60; t += 1) expect(Math.abs(genevaAngle(4, k, t + 1) - genevaAngle(4, k, t))).toBeLessThan(5)
  })

  it('builds a pair that does not collide over a turn', async () => {
    let doc = crank(emptyDoc())
    doc = run(doc, 'geneva', { name: 'gd', part: 'drive', slots: 4, distance: 40, pin_d: 4, width: 5, bore: 5, angle: 'crank' })
    doc = run(doc, 'geneva', { name: 'gw', part: 'wheel', drive: 'gd', bore: 5 })
    const k = new Kernel()
    const b = k.build(doc)
    expect(b.features.filter((f) => !f.ok).map((f) => f.error)).toEqual([])
    const plan = await q(doc, k, 'get_motion')
    expect(plan.moves.find((m: any) => m.body === 'gw').curve.kind).toBe('geneva')
    const sw = await q(doc, k, 'sweep_motion', { from: 0, to: 360, steps: 36 })
    expect(sw.collisions).toEqual([])
    const m = await q(doc, k, 'get_mechanisms')
    expect(m[0].index_per_turn).toBe(90)
  }, 120_000)
})

describe('cam', () => {
  it('drives a follower by the lift and reports the pressure angle', async () => {
    let doc = crank(emptyDoc())
    doc = run(doc, 'cam', { name: 'cam', base_r: 15, lift: '6*(1 - cos(t))/2', width: 6, bore: 5, roller: 3, rotation: 'crank' })
    doc = run(doc, 'cylinder', { name: 'follower', r: 3, h: 6, translate: [0, 21, -3] })
    doc = run(doc, 'set_motion', { joints: [{ body: 'follower', kind: 'cam', cam: 'cam' }] })
    const k = new Kernel()
    expect(k.build(doc).features.filter((f) => !f.ok)).toEqual([])
    const [m] = await q(doc, k, 'get_mechanisms')
    expect(m.stroke).toBeCloseTo(6, 3)
    expect(m.max_pressure_angle).toBeLessThan(30)
    expect(m.follower_point[1]).toBeCloseTo(15 + 3 + 6 * (1 - Math.cos(Math.PI / 2)) / 2, 3)
    const plan = await q(doc, k, 'get_motion')
    const f = plan.moves.find((x: any) => x.body === 'follower')
    // Turning the cam +90° brings cam angle 0 (lift 0) under the follower at 90°.
    const p = drivenPose(f, 90)
    expect(p.t[1]).toBeCloseTo(0 - 3, 3)
    // Roller and cam just touch: no overlap over a turn.
    const sw = await q(doc, k, 'sweep_motion', { from: 0, to: 360, steps: 24, min_volume: 0.05 })
    expect(sw.collisions.map((c: any) => [c.first, c.volume_at_first, c.worst_at])).toEqual([])
  }, 120_000)

  it('rejects a lift that reaches the center', () => {
    let doc = crank(emptyDoc())
    doc = run(doc, 'cam', { name: 'cam', base_r: 5, lift: '-10*sin(t)', width: 6 })
    const b = new Kernel().build(doc)
    expect(b.features[0].error).toMatch(/reaches the cam center/)
  })
})

describe('belt', () => {
  it('runs around pulleys and turns them at the diameter ratio', async () => {
    let doc = crank(emptyDoc())
    doc = run(doc, 'cylinder', { name: 'small', r: 6, h: 6 })
    doc = run(doc, 'cylinder', { name: 'big', r: 12, h: 6, translate: [60, 0, 0] })
    doc = run(doc, 'set_motion', { drive: { param: 'crank', speed: 90 }, joints: [{ body: 'small', kind: 'rotate', axis: [0, 0, 1], origin: [0, 0, 0] }] })
    doc = run(doc, 'belt', { name: 'belt', plane: 'XY', offset: 3, pulleys: [{ at: [0, 0], d: 12, body: 'small' }, { at: [60, 0], d: 24, body: 'big' }], thickness: 1, width: 4 })
    const k = new Kernel()
    expect(k.build(doc).features.filter((f) => !f.ok).map((f) => f.error)).toEqual([])
    const [m] = await q(doc, k, 'get_mechanisms')
    // Open belt: L = 2C + π(r1 + r2) + (r2 − r1)²/C, close to exact.
    const C = 60
    expect(m.length).toBeCloseTo(2 * Math.sqrt(C * C - 36) + Math.PI * 18 + 2 * 6 * Math.asin(6 / C), 1)
    const plan = await q(doc, k, 'get_motion')
    expect(plan.moves.find((x: any) => x.body === 'big').rate).toBeCloseTo(0.5, 9)
  }, 60_000)

  it('runs over the back of a tensioner and turns it the other way', async () => {
    let doc = crank(emptyDoc())
    doc = run(doc, 'cylinder', { name: 'left', r: 10, h: 6, translate: [0, 0, 0] })
    doc = run(doc, 'cylinder', { name: 'right', r: 10, h: 6, translate: [60, 0, 0] })
    doc = run(doc, 'cylinder', { name: 'idler', r: 5, h: 6, translate: [30, 13, 0] })
    doc = run(doc, 'set_motion', { drive: { param: 'crank', speed: 90 }, joints: [{ body: 'left', kind: 'rotate', axis: [0, 0, 1], origin: [0, 0, 0] }] })
    doc = run(doc, 'belt', {
      name: 'belt',
      plane: 'XY',
      offset: 3,
      pulleys: [{ at: [0, 0], d: 20, body: 'left' }, { at: [60, 0], d: 20, body: 'right' }, { at: [30, 13], d: 10, body: 'idler', back: true }],
      thickness: 1,
      width: 4,
    })
    const k = new Kernel()
    expect(k.build(doc).features.filter((f) => !f.ok).map((f) => f.error)).toEqual([])
    const [m] = await q(doc, k, 'get_mechanisms')
    // The idler sits 3 mm into the top run (y = 10) and bends it down. Expected
    // length from an independent tangent search: 60 + 2·29.0516 + 20·3.2093 + 5·0.1354.
    expect(m.length).toBeCloseTo(182.967, 1)
    const idler = m.pulleys.find((p: any) => p.body === 'idler')
    expect(idler.back).toBe(true)
    expect(idler.turns_per_turn_of_first).toBeCloseTo(-2, 5)
    const plan = await q(doc, k, 'get_motion')
    expect(plan.moves.find((x: any) => x.body === 'right').rate).toBeCloseTo(1, 9)
    expect(plan.moves.find((x: any) => x.body === 'idler').rate).toBeCloseTo(-2, 9)
  }, 60_000)

  it('says what to do with an idler inside the loop', async () => {
    let doc = emptyDoc()
    doc = run(doc, 'belt', { name: 'belt', plane: 'XY', pulleys: [{ at: [0, 0], d: 20 }, { at: [60, 0], d: 20 }, { at: [30, 5], d: 10 }], thickness: 1, width: 4 })
    const k = new Kernel()
    const f = k.build(doc).features.find((x) => x.name === 'belt')!
    expect(f.ok).toBe(false)
    expect(f.error).toMatch(/back: true/)
  }, 60_000)
})

describe('sweep_motion', () => {
  it('finds the first angle where a crank arm hits a post', async () => {
    let doc = crank(emptyDoc())
    doc = run(doc, 'box', { name: 'arm', size: [40, 4, 4], translate: [20, 0, 0] })
    doc = run(doc, 'box', { name: 'post', size: [4, 4, 4], translate: [0, 30, 0] })
    doc = run(doc, 'set_motion', { drive: { param: 'crank', speed: 90 }, joints: [{ body: 'arm', kind: 'rotate', axis: [0, 0, 1], origin: [0, 0, 0] }] })
    const k = new Kernel()
    k.build(doc)
    const r = await q(doc, k, 'sweep_motion', { from: 0, to: 180, steps: 36 })
    expect(r.collisions.length).toBe(1)
    expect(r.collisions[0].first).toBeGreaterThan(70)
    expect(r.collisions[0].first).toBeLessThan(90)
    expect(r.collisions[0].last).toBeLessThan(110)
  }, 60_000)

  it('finds gears placed too close together', async () => {
    let doc = crank(emptyDoc())
    doc = run(doc, 'gear', { name: 'a', kind: 'spur', teeth: 20, module: 2, width: 4, rotation: 'crank' })
    // Meant to mesh at 50 mm; 47 makes the teeth run into each other.
    doc = run(doc, 'gear', { name: 'b', kind: 'spur', teeth: 30, module: 2, width: 4, center: [47, 0, 0] })
    doc = run(doc, 'set_motion', { joints: [{ body: 'b', kind: 'rotate', axis: [0, 0, 1], origin: [47, 0, 0], rate: -20 / 30 }] })
    const k = new Kernel()
    k.build(doc)
    const r = await q(doc, k, 'sweep_motion', { from: 0, to: 36, steps: 36 })
    expect(r.collisions.length).toBe(1)
    expect(r.collisions[0].first).toBe(0)
  }, 120_000)

  it('follows a nonlinear position expression', async () => {
    let doc = crank(emptyDoc())
    doc = run(doc, 'box', { name: 'slider', size: [4, 4, 4] })
    doc = run(doc, 'set_motion', { drive: { param: 'crank', speed: 90 }, joints: [{ body: 'slider', kind: 'slide', axis: [1, 0, 0], position: '10*sin(crank)' }] })
    const k = new Kernel()
    k.build(doc)
    const plan = await q(doc, k, 'get_motion')
    expect(drivenPose(plan.moves[0], 90).t[0]).toBeCloseTo(10, 9)
    expect(drivenPose(plan.moves[0], 180).t[0]).toBeCloseTo(0, 9)
  })
})
