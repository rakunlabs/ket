// Reading a KiCad board (.kicad_pcb, KiCad 6 to 9) into Ket's PCB: the
// outline (Edge.Cuts lines, arcs, circles, polygons), footprints with their
// pads, silk and courtyard, nets, tracks, vias, zones and keep-out rule
// areas, mounting holes. What has no place in Ket is listed, never dropped
// silently. Pure: no I/O, so an import replays from the op alone.

import type { Component, CopperLayer, Footprint, Keepout, Net, Pad, Pcb, Track, Via, Zone } from '../doc'
import { copperLayersOf } from '../doc'
import { emptyPcb } from './board'

type S = string | S[]

/** KiCad's S-expressions: lists, atoms and "quoted strings". */
export function parseSexpr(text: string): S {
  let i = 0
  const n = text.length
  const ws = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '\r')) i++
  }
  const read = (): S => {
    ws()
    if (text[i] === '(') {
      i++
      const list: S[] = []
      for (;;) {
        ws()
        if (i >= n) throw new Error('the file ends inside a list: it is cut off or not a KiCad board')
        if (text[i] === ')') {
          i++
          return list
        }
        list.push(read())
      }
    }
    if (text[i] === '"') {
      i++
      let s = ''
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\') {
          i++
          s += text[i] === 'n' ? '\n' : text[i]
        } else s += text[i]
        i++
      }
      i++
      return s
    }
    const start = i
    while (i < n && !/[\s()"]/.test(text[i])) i++
    if (i === start) throw new Error(`unexpected "${text[i]}" at character ${i}`)
    return text.slice(start, i)
  }
  const root = read()
  return root
}

const isList = (s: S | undefined): s is S[] => Array.isArray(s)
const kids = (s: S | undefined, tag: string): S[][] => (isList(s) ? (s.filter((x) => isList(x) && x[0] === tag) as S[][]) : [])
const kid = (s: S | undefined, tag: string): S[] | undefined => kids(s, tag)[0]
const num = (s: S | undefined, fb = 0) => (typeof s === 'string' && s !== '' && !Number.isNaN(Number(s)) ? Number(s) : fb)
const str = (s: S | undefined) => (typeof s === 'string' ? s : '')

const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0

export interface KicadImport {
  pcb: Pcb
  /** The board outline and cut-outs in Ket coordinates: the import makes an XY sketch of them. */
  outline: [number, number][]
  cutouts: [number, number][][]
  /** Where the board was in KiCad's page: moved to Ket's origin by this, mm. */
  offset: [number, number]
  /** What was not carried over, or changed on the way. */
  losses: string[]
  counts: Record<string, number>
}

const KNOWN_TOP = new Set(['version', 'generator', 'generator_version', 'general', 'paper', 'title_block', 'layers', 'setup', 'property', 'net', 'net_class', 'footprint', 'module', 'gr_line', 'gr_arc', 'gr_circle', 'gr_rect', 'gr_poly', 'gr_curve', 'gr_text', 'segment', 'arc', 'via', 'zone', 'embedded_fonts', 'dimension', 'target', 'group', 'image', 'generated', 'gr_text_box', 'table', 'embedded_files'])

export function readKicadPcb(text: string): KicadImport {
  const root = parseSexpr(text)
  if (!isList(root) || root[0] !== 'kicad_pcb') throw new Error('not a KiCad board: the file must start with (kicad_pcb ...); save it from KiCad 6 or newer as .kicad_pcb')
  const losses: string[] = []
  const lose = (s: string) => {
    if (!losses.includes(s)) losses.push(s)
  }

  // Copper layers of the board, by KiCad's names.
  const copper = (kid(root, 'layers') ?? []).filter(isList).map((l) => ({ name: str(l[1]), kind: str(l[2]) })).filter((l) => l.kind === 'signal' || l.kind === 'power' || l.kind === 'mixed' || l.kind === 'jumper')
  const count = copper.length
  if (![2, 4, 6].includes(count)) throw new Error(`the board has ${count} copper layers; Ket boards have 2, 4 or 6`)
  const layers = copperLayersOf(count as 2 | 4 | 6)
  // KiCad inner names (In1..In(n-2)) map in order onto Ket's.
  const inner = copper.map((l) => l.name).filter((n) => n !== 'F.Cu' && n !== 'B.Cu')
  const layerMap = new Map<string, CopperLayer>([['F.Cu', 'F.Cu'], ['B.Cu', 'B.Cu'], ...inner.map((n, i) => [n, layers[i + 1]] as [string, CopperLayer])])
  const cu = (name: string): CopperLayer | undefined => layerMap.get(name)

  for (const t of root.slice(1)) if (isList(t) && !KNOWN_TOP.has(str(t[0]))) lose(`top-level "${str(t[0])}" items`)

  // Nets: number → name (KiCad 9 may write names only on pads).
  const netName = new Map<number, string>()
  for (const nItem of kids(root, 'net')) netName.set(num(nItem[1]), str(nItem[2]))
  const netOf = (l: S[] | undefined): string | undefined => {
    const x = kid(l, 'net')
    if (!x) return undefined
    const name = x[2] !== undefined ? str(x[2]) : netName.get(num(x[1])) ?? ''
    return name || undefined
  }

  // Outline: Edge.Cuts graphics, joined into loops.
  type Seg = { a: [number, number]; b: [number, number]; pts: [number, number][] }
  const segs: Seg[] = []
  const circles: { c: [number, number]; r: number }[] = []
  const P = (l: S[] | undefined): [number, number] => [num(l?.[1]), num(l?.[2])]
  const arcPts = (s: [number, number], m: [number, number], e: [number, number]): [number, number][] => {
    // Circle through three points, sampled every ~5°.
    const [ax, ay] = s
    const [bx, by] = m
    const [cx, cy] = e
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if (Math.abs(d) < 1e-12) return [s, e]
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    const r = Math.hypot(ax - ux, ay - uy)
    const a0 = Math.atan2(ay - uy, ax - ux)
    const am = Math.atan2(by - uy, bx - ux)
    let a1 = Math.atan2(cy - uy, cx - ux)
    // Go the way that passes the middle point.
    const ccw = (((am - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) < (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    let sweep = (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    if (!ccw) sweep -= 2 * Math.PI
    a1 = a0 + sweep
    const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 36)))
    const out: [number, number][] = []
    for (let k = 0; k <= steps; k++) {
      const a = a0 + (sweep * k) / steps
      out.push([ux + r * Math.cos(a), uy + r * Math.sin(a)])
    }
    out[0] = s
    out[out.length - 1] = e
    return out
  }
  for (const g of root.slice(1)) {
    if (!isList(g) || str(kid(g, 'layer')?.[1]) !== 'Edge.Cuts') continue
    const tag = str(g[0])
    if (tag === 'gr_line') {
      const a = P(kid(g, 'start'))
      const b = P(kid(g, 'end'))
      segs.push({ a, b, pts: [a, b] })
    } else if (tag === 'gr_arc') {
      const a = P(kid(g, 'start'))
      const b = P(kid(g, 'end'))
      const m = kid(g, 'mid')
      if (!m) {
        lose('Edge.Cuts arcs in the KiCad 5 form (no mid point): save the board again in KiCad 6 or newer')
        continue
      }
      segs.push({ a, b, pts: arcPts(a, P(m), b) })
    } else if (tag === 'gr_circle') {
      const c = P(kid(g, 'center'))
      const e = P(kid(g, 'end'))
      circles.push({ c, r: Math.hypot(e[0] - c[0], e[1] - c[1]) })
    } else if (tag === 'gr_rect') {
      const [x0, y0] = P(kid(g, 'start'))
      const [x1, y1] = P(kid(g, 'end'))
      for (const [a, b] of [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]] as [[number, number], [number, number]][]) segs.push({ a, b, pts: [a, b] })
    } else if (tag === 'gr_poly') {
      const pts = kids(kid(g, 'pts'), 'xy').map((q) => P(q))
      for (let k = 0; k < pts.length; k++) segs.push({ a: pts[k], b: pts[(k + 1) % pts.length], pts: [pts[k], pts[(k + 1) % pts.length]] })
    } else if (tag === 'gr_curve') lose('Bézier curves on Edge.Cuts (drawn as straight lines between their ends)')
  }
  const loops: [number, number][][] = []
  const near = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01
  const left = [...segs]
  while (left.length) {
    const first = left.shift()!
    const loop = [...first.pts]
    for (let guard = 0; guard < 10000 && !near(loop[0], loop[loop.length - 1]); guard++) {
      const end = loop[loop.length - 1]
      const i = left.findIndex((s) => near(s.a, end) || near(s.b, end))
      if (i < 0) break
      const s = left.splice(i, 1)[0]
      loop.push(...(near(s.a, end) ? s.pts : [...s.pts].reverse()).slice(1))
    }
    if (near(loop[0], loop[loop.length - 1]) && loop.length > 3) loops.push(loop.slice(0, -1))
    else lose('an open Edge.Cuts outline (its ends do not meet): closed loops only')
  }
  for (const c of circles) {
    const pts: [number, number][] = []
    for (let k = 0; k < 64; k++) pts.push([c.c[0] + c.r * Math.cos((k / 64) * 2 * Math.PI), c.c[1] + c.r * Math.sin((k / 64) * 2 * Math.PI)])
    loops.push(pts)
  }
  if (!loops.length) throw new Error('the board has no closed outline on Edge.Cuts')
  const area = (l: [number, number][]) => Math.abs(l.reduce((s, p, k) => s + p[0] * l[(k + 1) % l.length][1] - l[(k + 1) % l.length][0] * p[1], 0) / 2)
  loops.sort((x, y) => area(y) - area(x))
  const outer = loops[0]
  // Ket's origin at the outline's centre, y up.
  const xs = outer.map((p) => p[0])
  const ys = outer.map((p) => p[1])
  const ox = (Math.min(...xs) + Math.max(...xs)) / 2
  const oy = (Math.min(...ys) + Math.max(...ys)) / 2
  const X = (x: number) => r4(x - ox)
  const Y = (y: number) => r4(-(y - oy))
  const toKet = (p: [number, number]): [number, number] => [X(p[0]), Y(p[1])]

  const pcb: Pcb = { ...emptyPcb(), layers: count as 2 | 4 | 6, thickness: num(kid(kid(root, 'general'), 'thickness')?.[1], 1.6) }
  const outlineKet = outer.map(toKet)
  const cutoutsKet = loops.slice(1).map((l) => l.map(toKet))

  // Footprints.
  const nets = new Map<string, string[]>()
  const components: Component[] = []
  const holes: Pcb['holes'] = []
  const refs = new Set<string>()
  let fpCount = 0
  for (const fp of [...kids(root, 'footprint'), ...kids(root, 'module')]) {
    fpCount++
    const at = kid(fp, 'at')
    const [fx, fy] = [num(at?.[1]), num(at?.[2])]
    const rot = num(at?.[3])
    const bottom = str(kid(fp, 'layer')?.[1]) === 'B.Cu'
    const prop = (name: string) => str(kids(fp, 'property').find((p) => p[1] === name)?.[2]) || str(kids(fp, 'fp_text').find((p) => p[1] === name.toLowerCase())?.[2])
    let ref = prop('Reference') || `X${fpCount}`
    const pads = kids(fp, 'pad')
    // A footprint with only unplated, unnamed holes is a mounting hole.
    if (pads.length && pads.every((p) => str(p[2]) === 'np_thru_hole') && pads.length <= 2) {
      for (const p of pads) {
        const pa = kid(p, 'at')
        const [lx, ly] = [num(pa?.[1]), num(pa?.[2])]
        const t = (rot * Math.PI) / 180
        const wx = fx + lx * Math.cos(t) + ly * Math.sin(t)
        const wy = fy - lx * Math.sin(t) + ly * Math.cos(t)
        holes.push({ at: toKet([wx, wy]), d: r4(num(kid(p, 'drill')?.[1])) })
      }
      continue
    }
    if (!/^[A-Z]+[0-9]+$/.test(ref)) {
      const clean = ref.toUpperCase().replace(/[^A-Z0-9]/g, '')
      const fixed = /^[A-Z]+[0-9]+$/.test(clean) ? clean : `X${fpCount}`
      lose(`references like "${ref}" are renamed (Ket refs are letters then digits): ${ref} → ${fixed}`)
      ref = fixed
    }
    while (refs.has(ref)) ref = `${ref.replace(/[0-9]+$/, '')}${Number(/[0-9]+$/.exec(ref)?.[0] ?? 0) + 1000}`
    refs.add(ref)
    // Local points: KiCad puts a local point at at + R(rot)·(lx, ly) in its y-down frame, on both sides.
    // Ket puts a local point L at at + rot(m(L)) in its y-up frame, m mirroring x on the bottom.
    // So L = m⁻¹(rot⁻¹(world − at)) with world from KiCad's rule: the part lands where KiCad has it.
    const th = (rot * Math.PI) / 180
    const [cs, sn] = [Math.cos(th), Math.sin(th)]
    const loc = (lx: number, ly: number) => {
      // KiCad world offset (y down), then y up.
      const dx = lx * cs + ly * sn
      const dy = -(-lx * sn + ly * cs)
      // Undo Ket's rotation (CCW by rot, y up), then its bottom mirror.
      const ux = dx * cs + dy * sn
      const uy = -dx * sn + dy * cs
      return { x: r4(bottom ? -ux : ux), y: r4(uy) }
    }
    const fpPads: Pad[] = []
    const pins: Record<string, string> = {}
    for (const p of pads) {
      const number = str(p[1])
      const type = str(p[2])
      const shape = str(p[3])
      const pa = kid(p, 'at')
      const [lx, ly] = [num(pa?.[1]), num(pa?.[2])]
      const angle = num(pa?.[3]) // absolute in KiCad
      const size = kid(p, 'size')
      const [w, h] = [num(size?.[1]), num(size?.[2])]
      const dr = kid(p, 'drill')
      if (type === 'np_thru_hole' && !number) {
        // A locating peg inside a part: a footprint hole.
        continue
      }
      const pad: Pad = {
        number: number || String(fpPads.length + 1),
        shape: shape === 'circle' ? 'circle' : shape === 'oval' ? 'oval' : shape === 'custom' ? 'polygon' : 'rect',
        at: loc(lx, ly),
        // KiCad's pad angle is absolute and CCW on screen, as Ket's. Ket turns a pad by its own
        // rotation, mirrors it on the bottom (which reverses that turn), then turns it with the part.
        rotation: r4(bottom ? rot - angle : angle - rot),
        w: r4(w),
        h: r4(h),
        layer: 'through',
      }
      if (type === 'smd' || type === 'connect') {
        // The pad's own copper layer (an edge connector's B.Cu fingers sit in an F.Cu footprint).
        const pl = (kid(p, 'layers') ?? []).slice(1).map(str)
        const onB = pl.includes('B.Cu') && !pl.includes('F.Cu')
        const onF = pl.includes('F.Cu') && !pl.includes('B.Cu')
        // Ket's pad side is relative to the part: 'top' is the side the part sits on.
        pad.layer = onB ? (bottom ? 'top' : 'bottom') : onF ? (bottom ? 'bottom' : 'top') : bottom ? 'bottom' : 'top'
        if (pl.includes('F.Cu') && pl.includes('B.Cu')) lose('SMD pads on both outer layers (they keep one)')
      }
      if (shape === 'roundrect' || shape === 'chamfered_rect') lose('rounded and chamfered pad corners (they become square)')
      if (shape === 'trapezoid') lose('trapezoid pads (they become rectangles)')
      if (shape === 'custom') {
        const poly = kids(kid(kid(p, 'primitives'), 'gr_poly'), 'pts').flatMap((pts) => kids(pts, 'xy')).map((q) => ({ x: r4(num(q[1])), y: r4(-num(q[2])) }))
        if (poly.length >= 3) pad.polygon = bottom ? poly.map((q) => ({ x: -q.x, y: q.y })) : poly
        else {
          pad.shape = 'rect'
          lose('custom pads made of other primitives than one polygon (they become their anchor pad)')
        }
      }
      if (dr) {
        const oval = dr[1] === 'oval'
        const d1 = num(dr[oval ? 2 : 1])
        const d2 = oval ? num(dr[3], d1) : d1
        pad.drill = { d: r4(Math.min(d1, d2)), plated: type !== 'np_thru_hole', ...(oval && Math.abs(d1 - d2) > 1e-6 ? { slot: r4(Math.max(d1, d2)) } : {}) }
      }
      fpPads.push(pad)
      const func = str(kid(p, 'pinfunction')?.[1])
      if (func) pins[pad.number] = func
      const net = netOf(p)
      if (net) {
        if (!nets.has(net)) nets.set(net, [])
        nets.get(net)!.push(`${ref}.${pad.number}`)
      }
    }
    const silk: Footprint['silk'] = []
    const court: { x: number; y: number }[] = []
    for (const g of [...kids(fp, 'fp_line'), ...kids(fp, 'fp_rect')]) {
      const layer = str(kid(g, 'layer')?.[1])
      const a = kid(g, 'start')
      const b = kid(g, 'end')
      const w = num(kid(kid(g, 'stroke'), 'width')?.[1], num(kid(g, 'width')?.[1], 0.12))
      const lines = g[0] === 'fp_rect' ? [[num(a?.[1]), num(a?.[2]), num(b?.[1]), num(a?.[2])], [num(b?.[1]), num(a?.[2]), num(b?.[1]), num(b?.[2])], [num(b?.[1]), num(b?.[2]), num(a?.[1]), num(b?.[2])], [num(a?.[1]), num(b?.[2]), num(a?.[1]), num(a?.[2])]] : [[num(a?.[1]), num(a?.[2]), num(b?.[1]), num(b?.[2])]]
      for (const [x1, y1, x2, y2] of lines) {
        const p1 = loc(x1, y1)
        const p2 = loc(x2, y2)
        if (layer.endsWith('SilkS')) silk.push([p1.x, p1.y, p2.x, p2.y, w])
        if (layer.endsWith('CrtYd')) court.push(p1, p2)
      }
    }
    if (kids(fp, 'fp_arc').length || kids(fp, 'fp_circle').length || kids(fp, 'fp_poly').length) lose('footprint silkscreen arcs, circles and polygons (lines and rectangles are kept)')
    if (kids(fp, 'model').length) lose("footprints' 3D models (give parts a model with add_component model)")
    // Courtyard: its box (Ket courtyards are outlines), else the pads' box plus 0.25 mm.
    const box = (pts: { x: number; y: number }[]) => {
      const x0 = Math.min(...pts.map((q) => q.x))
      const x1 = Math.max(...pts.map((q) => q.x))
      const y0 = Math.min(...pts.map((q) => q.y))
      const y1 = Math.max(...pts.map((q) => q.y))
      return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
    }
    const padPts = fpPads.flatMap((q) => [{ x: q.at.x - q.w / 2 - 0.25, y: q.at.y - q.h / 2 - 0.25 }, { x: q.at.x + q.w / 2 + 0.25, y: q.at.y + q.h / 2 + 0.25 }])
    const courtyard = court.length ? box(court) : padPts.length ? box(padPts) : [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }]
    const fpHoles = pads.filter((p) => str(p[2]) === 'np_thru_hole' && !str(p[1])).map((p) => {
      const pa = kid(p, 'at')
      return { at: loc(num(pa?.[1]), num(pa?.[2])), d: r4(num(kid(p, 'drill')?.[1])) }
    })
    const name = str(fp[1]).split(':').pop() || 'footprint'
    const value = prop('Value')
    const lcsc = prop('LCSC') || prop('LCSC Part') || prop('JLCPCB Part #')
    const attr = kid(fp, 'attr')
    components.push({
      ref,
      lcsc: lcsc || '',
      ...(value ? { value } : {}),
      package: name,
      at: [X(fx), Y(fy)],
      rotation: r4(rot),
      ...(bottom ? { side: 'bottom' } : {}),
      ...(attr?.includes('dnp') || attr?.includes('exclude_from_bom') ? { dnp: true } : {}),
      footprint: { name, pads: fpPads, silk, courtyard, pins, ...(fpHoles.length ? { holes: fpHoles } : {}) },
    } as Component)
  }
  pcb.components = components
  pcb.holes = holes
  pcb.nets = [...nets].filter(([, p]) => p.length).map(([name, pins]): Net => ({ name, pins }))
  const known = new Set(pcb.nets.map((x) => x.name))

  // Tracks: consecutive segments of a net on a layer at one width become one polyline when they chain.
  const tracks: Track[] = []
  let arcs = 0
  for (const s of [...kids(root, 'segment'), ...kids(root, 'arc')]) {
    const layer = cu(str(kid(s, 'layer')?.[1]))
    const net = netOf(s)
    if (!layer || !net || !known.has(net)) continue
    const w = r4(num(kid(s, 'width')?.[1], 0.25))
    let pts: [number, number][]
    if (s[0] === 'arc') {
      arcs++
      pts = arcPts(P(kid(s, 'start')), P(kid(s, 'mid')), P(kid(s, 'end'))).map(toKet)
    } else pts = [toKet(P(kid(s, 'start'))), toKet(P(kid(s, 'end')))]
    const last = tracks.find((t) => t.net === net && t.layer === layer && t.width === w && near(t.points[t.points.length - 1], pts[0]))
    if (last) last.points.push(...pts.slice(1))
    else tracks.push({ net, layer, width: w, points: pts })
  }
  if (arcs) lose(`${arcs} arc track(s) are polylines (Ket tracks are straight segments)`)
  pcb.tracks = tracks

  const vias: Via[] = []
  for (const v of kids(root, 'via')) {
    const net = netOf(v)
    if (!net || !known.has(net)) continue
    const ls = (kid(v, 'layers') ?? []).slice(1).map((l) => cu(str(l)))
    const span = ls[0] && ls[1] && !(ls[0] === 'F.Cu' && ls[1] === 'B.Cu') ? ([ls[0], ls[1]] as [CopperLayer, CopperLayer]) : undefined
    if (v[1] === 'micro') lose('microvias (they become blind vias)')
    vias.push({ net, at: toKet(P(kid(v, 'at'))), drill: r4(num(kid(v, 'drill')?.[1], 0.3)), diameter: r4(num(kid(v, 'size')?.[1], 0.6)), ...(span ? { span } : {}) })
  }
  pcb.vias = vias

  const zones: Zone[] = []
  const keepouts: Keepout[] = []
  for (const z of kids(root, 'zone')) {
    const poly = kids(kid(kid(z, 'polygon'), 'pts'), 'xy').map((q) => toKet(P(q)))
    if (poly.length < 3) continue
    const zl = [...(kid(z, 'layer') ?? []).slice(1), ...(kid(z, 'layers') ?? []).slice(1)].map(str)
    const zlayers = zl.includes('*.Cu') || zl.includes('F&B.Cu') ? layers : (zl.map(cu).filter(Boolean) as CopperLayer[])
    const ko = kid(z, 'keepout')
    if (ko) {
      const forbid: Keepout['forbid'] = []
      const no = (k: string) => str(kid(ko, k)?.[1]) === 'not_allowed'
      if (no('tracks')) forbid.push('tracks')
      if (no('vias')) forbid.push('vias')
      if (no('copperpour')) forbid.push('pours')
      if (no('footprints')) forbid.push('parts')
      if (no('pads')) lose('keep-outs that forbid pads (Ket keeps tracks, vias, pours and parts out)')
      if (forbid.length) keepouts.push({ name: (str(kid(z, 'name')?.[1]) || `keepout${keepouts.length + 1}`).replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1'), polygon: poly, ...(zlayers.length === layers.length ? {} : { layers: zlayers }), forbid })
      continue
    }
    const net = netOf(z)
    if (!net || !known.has(net)) {
      lose('zones without a net (copper islands) are left out')
      continue
    }
    const cp = kid(z, 'connect_pads')
    const fill = kid(z, 'fill')
    for (const layer of zlayers) {
      zones.push({
        net,
        layer,
        polygon: poly,
        clearance: r4(num(kid(cp, 'clearance')?.[1], 0.2)) || undefined,
        ...(cp?.[1] === 'yes' ? { thermal: false as const } : { thermal: { gap: r4(num(kid(fill, 'thermal_gap')?.[1], 0.5)), spoke: r4(num(kid(fill, 'thermal_bridge_width')?.[1], 0.5)) } }),
        priority: num(kid(z, 'priority')?.[1]) || undefined,
      } as Zone)
    }
  }
  pcb.zones = zones.length ? zones : undefined
  if (keepouts.length) pcb.keepouts = keepouts
  if (kids(root, 'gr_text').some((g) => str(kid(g, 'layer')?.[1]).endsWith('SilkS'))) lose('board silkscreen text (add it again with add_board_artwork)')
  if (kids(root, 'net_class').length || kid(kid(root, 'setup'), 'stackup')) lose('net classes and the stackup (set them with set_net_class and set_stackup)')

  return {
    pcb,
    outline: outlineKet,
    cutouts: cutoutsKet,
    offset: [r4(ox), r4(oy)],
    losses,
    counts: { footprints: components.length, mounting_holes: holes.length, nets: pcb.nets.length, tracks: tracks.length, vias: vias.length, zones: zones.length, keepouts: keepouts.length, outline_points: outlineKet.length, cutouts: cutoutsKet.length },
  }
}
