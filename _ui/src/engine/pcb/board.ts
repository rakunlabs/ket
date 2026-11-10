// Resolves the PCB part of a document into plain geometry: parameters
// evaluated, the outline taken from its sketch, pads placed in board
// coordinates and tagged with their nets. DRC, ratsnest, the autorouter
// export, Gerber and the 3D board all start from a ResolvedBoard.

import type { Doc, NetClass, Pcb } from '../doc'
import { num } from '../expr'
import type { SolvedSketch } from '../sketch'
import { type Placed, type Poly, type WorldPad, bboxOf, courtyard, polyArea, worldPads } from './geometry'

export const DEFAULT_CLASS: NetClass = { name: 'default', track: 0.25, clearance: 0.2, via_drill: 0.3, via_diameter: 0.6 }

export interface ResolvedBoard {
  outline: Poly
  /** Holes cut from the outline (inner loops of the outline sketch). */
  cutouts: Poly[]
  thickness: number
  z: number
  layers: 2 | 4
  components: (Placed & { lcsc: string; value?: string; mpn?: string; package?: string; basic?: boolean; edge?: boolean; height: number; courtyard: Poly })[]
  pads: WorldPad[]
  classes: Map<string, NetClass>
  netClass: Map<string, NetClass>
  holes: { at: { x: number; y: number }; d: number }[]
  errors: string[]
}

export function emptyPcb(): Pcb {
  return {
    outline: { rect: { w: 50, h: 30 } },
    thickness: 1.6,
    layers: 2,
    rules: 'jlcpcb',
    components: [],
    nets: [],
    classes: [],
    tracks: [],
    vias: [],
    holes: [],
  }
}

function loopToPoly(loop: SolvedSketch['loops'][number]): Poly {
  const out: Poly = []
  for (const s of loop.segments) {
    if (s.kind === 'circle') {
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * 2 * Math.PI
        out.push({ x: s.c[0] + s.r * Math.cos(a), y: s.c[1] + s.r * Math.sin(a) })
      }
      return out
    }
    out.push({ x: s.from[0], y: s.from[1] })
    if (s.kind === 'arc') {
      // Tessellate through the midpoint.
      const [ax, ay] = s.from
      const [mx, my] = s.mid
      const [bx, by] = s.to
      const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my))
      if (Math.abs(d) < 1e-12) continue
      const ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d
      const uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d
      const r = Math.hypot(ax - ux, ay - uy)
      const a0 = Math.atan2(ay - uy, ax - ux)
      const am = Math.atan2(my - uy, mx - ux)
      const a1 = Math.atan2(by - uy, bx - ux)
      // Direction through the midpoint.
      const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      const ccw = norm(am - a0) < norm(a1 - a0)
      const sweep = ccw ? norm(a1 - a0) : -norm(a0 - a1)
      const steps = Math.max(4, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * 48))
      for (let i = 1; i < steps; i++) {
        const a = a0 + (sweep * i) / steps
        out.push({ x: ux + r * Math.cos(a), y: uy + r * Math.sin(a) })
      }
    }
  }
  return out
}

/**
 * sketch resolves a sketch by name (the kernel's solver). Errors are
 * collected, not thrown, so a half-finished board still shows.
 */
export function resolveBoard(doc: Doc, params: Map<string, number>, sketch: (name: string) => SolvedSketch): ResolvedBoard {
  const pcb = doc.pcb!
  const errors: string[] = []
  const v = (e: Parameters<typeof num>[0], what: string, fb?: number) => {
    try {
      return num(e, params, what, fb)
    } catch (err) {
      errors.push((err as Error).message)
      return fb ?? 0
    }
  }

  let outline: Poly = []
  const cutouts: Poly[] = []
  if ('sketch' in pcb.outline) {
    try {
      const s = doc.sketches.find((x) => x.name === (pcb.outline as { sketch: string }).sketch)
      if (!s) throw new Error(`board outline: no sketch "${(pcb.outline as { sketch: string }).sketch}"`)
      if (s.plane !== 'XY') throw new Error(`board outline: sketch ${s.name} is on ${s.plane}; the board outline must be an XY sketch`)
      const sk = sketch(s.name)
      if (!sk.ok) throw new Error(`board outline: sketch ${s.name} does not solve: ${sk.message}`)
      if (!sk.loops.length) throw new Error(`board outline: sketch ${s.name} has no closed loop`)
      outline = loopToPoly(sk.loops[0])
      for (const l of sk.loops.slice(1)) cutouts.push(loopToPoly(l))
    } catch (e) {
      errors.push((e as Error).message)
    }
  } else {
    const r = pcb.outline.rect
    const w = v(r.w, 'board outline w')
    const h = v(r.h, 'board outline h')
    const rr = v(r.r, 'board outline r', 0)
    const cx = r.center ? v(r.center[0], 'board center x') : 0
    const cy = r.center ? v(r.center[1], 'board center y') : 0
    if (rr > 0) {
      const steps = 8
      const corner = (x: number, y: number, a0: number) => {
        for (let i = 0; i <= steps; i++) {
          const a = a0 + (i / steps) * (Math.PI / 2)
          outline.push({ x: x + rr * Math.cos(a), y: y + rr * Math.sin(a) })
        }
      }
      corner(cx + w / 2 - rr, cy - h / 2 + rr, -Math.PI / 2)
      corner(cx + w / 2 - rr, cy + h / 2 - rr, 0)
      corner(cx - w / 2 + rr, cy + h / 2 - rr, Math.PI / 2)
      corner(cx - w / 2 + rr, cy - h / 2 + rr, Math.PI)
    } else {
      outline = [
        { x: cx - w / 2, y: cy - h / 2 },
        { x: cx + w / 2, y: cy - h / 2 },
        { x: cx + w / 2, y: cy + h / 2 },
        { x: cx - w / 2, y: cy + h / 2 },
      ]
    }
  }
  if (outline.length && polyArea(outline) < 0) outline.reverse()

  const classes = new Map<string, NetClass>([[DEFAULT_CLASS.name, DEFAULT_CLASS]])
  for (const c of pcb.classes) classes.set(c.name, c)
  const netClass = new Map<string, NetClass>()
  for (const n of pcb.nets) netClass.set(n.name, classes.get(n.class ?? 'default') ?? DEFAULT_CLASS)

  const pinNet = new Map<string, string>()
  for (const n of pcb.nets) for (const p of n.pins) pinNet.set(p, n.name)

  const components: ResolvedBoard['components'] = []
  const pads: WorldPad[] = []
  for (const c of pcb.components) {
    const placed: Placed = {
      ref: c.ref,
      at: { x: v(c.at[0], `${c.ref}.at[0]`), y: v(c.at[1], `${c.ref}.at[1]`) },
      rotation: v(c.rotation, `${c.ref}.rotation`, 0),
      side: c.side ?? 'top',
      footprint: c.footprint,
    }
    const height = v(c.height, `${c.ref}.height`, c.footprint.height ?? 1.5)
    components.push({ ...placed, lcsc: c.lcsc, value: c.value, mpn: c.mpn, package: c.package, basic: c.basic, edge: c.edge, height, courtyard: courtyard(placed) })
    for (const p of worldPads(placed, pcb.layers)) {
      p.net = pinNet.get(`${p.ref}.${p.pin}`)
      pads.push(p)
    }
  }

  return {
    outline,
    cutouts,
    thickness: v(pcb.thickness, 'board thickness', 1.6),
    z: v(pcb.placement?.z, 'board z', 0),
    layers: pcb.layers,
    components,
    pads,
    classes,
    netClass,
    holes: pcb.holes.map((h, i) => ({ at: { x: v(h.at[0], `hole ${i + 1} x`), y: v(h.at[1], `hole ${i + 1} y`) }, d: v(h.d, `hole ${i + 1} d`) })),
    errors,
  }
}

export function boardBox(b: ResolvedBoard) {
  return bboxOf(b.outline.length ? b.outline : [{ x: 0, y: 0 }])
}
