import { describe, expect, it } from 'vitest'
import * as R from 'replicad'
import type { Shape3D } from 'replicad'

import { applyOp, emptyDoc, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'

import './setup'

const run = (doc: Doc, cmd: string, args: unknown): Doc => applyOp(doc, { cmd, args }).doc

function overlap(k: Kernel, a: string, b: string, nudge?: { deg: number }): number {
  const s1 = k.shape(a)
  let s2 = k.shape(b)
  if (nudge) {
    const g = k.gears.get(b) as { center: number[]; frame: { a: number[]; u: number[] }; kind: string }
    s2 = g.kind === 'rack' ? s2.translate(...(g.frame.u.map((v) => v * nudge.deg) as [number, number, number])) : s2.rotate(nudge.deg, g.center as [number, number, number], g.frame.a as [number, number, number])
  }
  const i = s1.intersect(s2) as Shape3D
  let v = 0
  try {
    v = R.measureVolume(i)
  } catch {
    v = 0
  }
  return v
}

/**
 * A pair meshes when, at each sampled rotation, the teeth do not
 * interpenetrate, but turning the driven gear a little either way (more
 * than the backlash) makes them collide: the flanks are really in contact.
 */
function checkMesh(doc: Doc, a: string, b: string, opts: { steps?: number; span?: number; nudge: number }) {
  const k = new Kernel()
  const steps = opts.steps ?? 2
  const out: { at: number; rest: number; plus: number; minus: number }[] = []
  for (let i = 0; i < steps; i++) {
    const at = ((opts.span ?? 40) * i) / steps
    const d = run(doc, 'set_parameters', { parameters: [{ name: 'crank', expr: at }] })
    const bad = k.build(d).features.filter((f) => !f.ok)
    expect(bad, JSON.stringify(bad)).toEqual([])
    out.push({ at, rest: overlap(k, a, b), plus: overlap(k, a, b, { deg: opts.nudge }), minus: overlap(k, a, b, { deg: -opts.nudge }) })
  }
  for (const r of out) {
    expect(r.rest, `teeth overlap at rest, crank ${r.at}`).toBeLessThan(1e-3)
    expect(r.plus, `no contact turning +, crank ${r.at}`).toBeGreaterThan(1e-4)
    expect(r.minus, `no contact turning −, crank ${r.at}`).toBeGreaterThan(1e-4)
  }
  return out
}

function checkMeshLoose(doc: Doc, a: string, b: string, nudge: number) {
  const k = new Kernel()
  k.build(doc)
  return { rest: overlap(k, a, b), plus: overlap(k, a, b, { deg: nudge }), minus: overlap(k, a, b, { deg: -nudge }) }
}

describe('gears', () => {
  it('twist extrusion with a positive angle turns counter-clockwise seen from +Z', () => {
    // Pins replicad's twist direction, which helical gears rely on.
    const d = R.drawRoundedRectangle(10, 1).translate(5, 0)
    const s = d.sketchOnPlane('XY', 0).extrude(10, { twistAngle: 90 }) as Shape3D
    const top = s.clone().intersect(R.makeBox([-20, -20, 9.9], [20, 20, 10]) as Shape3D) as Shape3D
    const [[x0, y0], [x1, y1]] = top.boundingBox.bounds
    // +90° CCW takes the bar on +X to +Y.
    expect((y0 + y1) / 2).toBeGreaterThan(3)
    expect(Math.abs((x0 + x1) / 2)).toBeLessThan(1)
  })

  it('places a spur pair at the center distance; the teeth touch but never interpenetrate', () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'crank', expr: 0 }] })
    doc = run(doc, 'gear', { name: 'a', kind: 'spur', teeth: 17, module: 2, width: 3, rotation: 'crank' })
    doc = run(doc, 'gear', { name: 'b', kind: 'spur', teeth: 31, module: 2, width: 3, mesh: { with: 'a', angle: 30 } })
    const k = new Kernel()
    const b = k.build(doc)
    const fb = b.features.find((f) => f.name === 'b')!
    expect(fb.ok, fb.error).toBe(true)
    const st = k.gears.get('b') as { center: number[]; ratio: number }
    expect(Math.hypot(st.center[0], st.center[1])).toBeCloseTo(48, 6)
    expect(st.ratio).toBeCloseTo(-17 / 31, 9)
    // backlash 0.11 mm on r = 31 mm ≈ 0.2°.
    checkMesh(doc, 'a', 'b', { nudge: 0.8, steps: 2, span: 7 })
  }, 120_000)

  it('meshes a helical pair with opposite hands', () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'crank', expr: 0 }] })
    doc = run(doc, 'gear', { name: 'a', kind: 'helical', teeth: 18, module: 1.5, width: 5, helix: 20, rotation: 'crank' })
    doc = run(doc, 'gear', { name: 'b', kind: 'helical', teeth: 24, module: 1.5, width: 5, mesh: { with: 'a' } })
    const k = new Kernel()
    k.build(doc)
    expect((k.gears.get('b') as { helix: number }).helix).toBe(-20)
    checkMesh(doc, 'a', 'b', { nudge: 1.2, steps: 1 })
  }, 120_000)

  it('meshes a pinion inside a ring gear', () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'crank', expr: 0 }] })
    doc = run(doc, 'gear', { name: 'ring', kind: 'internal', teeth: 40, module: 1.5, width: 3, rotation: 'crank' })
    doc = run(doc, 'gear', { name: 'pin', kind: 'spur', teeth: 16, module: 1.5, width: 3, mesh: { with: 'ring', angle: 60 } })
    checkMesh(doc, 'ring', 'pin', { nudge: 2, steps: 1 })
  }, 120_000)

  it('drives a rack', () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'crank', expr: 0 }] })
    doc = run(doc, 'gear', { name: 'pinion', kind: 'spur', teeth: 16, module: 2, width: 4, rotation: 'crank' })
    doc = run(doc, 'gear', { name: 'rack', kind: 'rack', module: 2, width: 4, length: 40, mesh: { with: 'pinion', angle: -90 } })
    // The rack nudge is in mm.
    checkMesh(doc, 'pinion', 'rack', { nudge: 0.35, steps: 2, span: 10 })
  }, 120_000)

  it('meshes a worm with its wheel and turns the wheel slowly', () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'crank', expr: 0 }] })
    doc = run(doc, 'gear', { name: 'worm', kind: 'worm', teeth: 1, module: 2, length: 16, diameter: 20, axis: 'X', rotation: 'crank' })
    doc = run(doc, 'gear', { name: 'wheel', kind: 'helical', teeth: 30, module: 2, width: 6, mesh: { with: 'worm', toward: [0, 0, 1] } })
    const k = new Kernel()
    const b = k.build(doc)
    expect(b.features.filter((f) => !f.ok)).toEqual([])
    const w = k.gears.get('wheel') as { center: number[]; ratio: number; helix: number; frame: { a: number[] } }
    expect(Math.abs(w.frame.a[1])).toBeCloseTo(1, 6)
    expect(Math.abs(w.ratio)).toBeCloseTo(1 / 30, 9)
    expect(w.helix).toBeCloseTo((Math.atan((2 * 1) / 20) * 180) / Math.PI, 6)
    // A helical wheel only approximates a worm wheel (point contact), so allow a little.
    const r = checkMeshLoose(doc, 'worm', 'wheel', 1.5)
    expect(r.rest).toBeLessThan(0.05)
    expect(r.plus).toBeGreaterThan(r.rest)
    expect(r.minus).toBeGreaterThan(r.rest)
  }, 300_000)

  it('meshes a 90° bevel pair', () => {
    let doc = emptyDoc()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'crank', expr: 0 }] })
    doc = run(doc, 'gear', { name: 'b1', kind: 'bevel', teeth: 20, module: 2, width: 6, pair_teeth: 30, rotation: 'crank' })
    doc = run(doc, 'gear', { name: 'b2', kind: 'bevel', teeth: 30, module: 2, width: 6, pair_teeth: 20, mesh: { with: 'b1', angle: 0 } })
    const k = new Kernel()
    const b = k.build(doc)
    expect(b.features.filter((f) => !f.ok)).toEqual([])
    const g2 = k.gears.get('b2') as { frame: { a: number[] }; ratio: number }
    expect(g2.frame.a[0]).toBeCloseTo(-1, 6)
    expect(g2.ratio).toBeCloseTo(-20 / 30, 9)
    // Bevels are tapered transverse profiles, not spherical involutes: a
    // little interference near the toe remains (≈1% of a tooth here).
    const r = checkMeshLoose(doc, 'b1', 'b2', 2)
    expect(r.rest).toBeLessThan(0.6)
    expect(r.plus).toBeGreaterThan(r.rest * 5)
    expect(r.minus).toBeGreaterThan(r.rest * 5)
  }, 120_000)

  it('picks the shift against undercut and the exact working center distance', () => {
    let doc = emptyDoc()
    doc = run(doc, 'gear', { name: 'p', kind: 'spur', teeth: 12, module: 3, width: 4, profile_shift: 'auto' })
    doc = run(doc, 'gear', { name: 'g', kind: 'spur', teeth: 24, module: 3, width: 4, mesh: { with: 'p' } })
    const k = new Kernel()
    const b = k.build(doc)
    const p = k.gears.get('p') as { shift: number; warnings: string[] }
    // zmin = 2/sin²20° ≈ 17.1 → x = (17.1 − 12)/17.1 ≈ 0.298.
    expect(p.shift).toBeCloseTo(0.298, 2)
    expect(p.warnings).toEqual([])
    // KHK example 4.2: z 12/24, m 3, x 0.6/0.36 → a = 56.4999. Here with x 0.298/0:
    const g = k.gears.get('g') as { center: number[]; warnings: string[] }
    const a = Math.hypot(g.center[0], g.center[1])
    expect(a).toBeGreaterThan(54)
    expect(a).toBeLessThan(54 + 0.298 * 3)
    expect(b.features.find((f) => f.name === 'g')!.warnings).toBeUndefined()
  })

  it('matches the KHK worked example for a shifted pair', () => {
    let doc = emptyDoc()
    doc = run(doc, 'gear', { name: 'p', kind: 'spur', teeth: 12, module: 3, width: 4, profile_shift: 0.6 })
    doc = run(doc, 'gear', { name: 'g', kind: 'spur', teeth: 24, module: 3, width: 4, profile_shift: 0.36, mesh: { with: 'p' } })
    const k = new Kernel()
    k.build(doc)
    const g = k.gears.get('g') as { center: number[] }
    expect(Math.hypot(g.center[0], g.center[1])).toBeCloseTo(56.4999, 3)
  })

  it('explains mistakes', () => {
    let doc = emptyDoc()
    doc = run(doc, 'gear', { name: 'a', kind: 'spur', teeth: 20, module: 2, width: 5 })
    doc = run(doc, 'gear', { name: 'b', kind: 'spur', teeth: 20, module: 1.5, width: 5, mesh: { with: 'a' } })
    const f = new Kernel().build(doc).features.find((x) => x.name === 'b')!
    expect(f.error).toMatch(/module 1.5 does not match "a"/)
    expect(() => run(emptyDoc(), 'gear', { name: 'c', kind: 'spur', teeth: 20, module: 2, width: 5, mesh: { with: 'nope' } })).toThrow(/no gear "nope"/)
  })
})
