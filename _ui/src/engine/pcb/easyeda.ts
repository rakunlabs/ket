// EasyEDA component → Footprint. Adapted from Flamingo's parser (MIT,
// github.com/cheewee2000/flamingo-pcb), which verified the conventions:
//   1 EasyEDA unit = 10 mil = 0.254 mm; shape coordinates are absolute
//   canvas coordinates; the footprint origin is packageDetail.dataStr.head
//   x/y; the canvas is y-down, so y is negated. Pad rotation flips sign.
// The symbol (result.dataStr) gives pin names for the pad numbers.

import type { Footprint, Model3D, P, Pad, SymbolDef } from '../doc'

const UNIT = 0.254
const LAYER_BOTTOM = 2
const LAYER_MULTI = 11
const SILK_TOP = 3
const BODY_LAYERS = new Set([99, 100, 12])

export interface PartInfo {
  lcsc: string
  mpn: string
  mfr: string
  package: string
  description: string
  basic: boolean
  stock?: number
  datasheet?: string
}

interface Raw {
  title?: string
  description?: string
  lcsc?: { number?: string; stock?: number }
  szlcsc?: { number?: string; stock?: number }
  dataStr?: { head?: { c_para?: Record<string, string> }; shape?: string[] }
  packageDetail?: { title?: string; dataStr?: { head?: { x?: number | string; y?: number | string; c_para?: Record<string, string> }; shape?: string[] } }
}

const n = (s: string | undefined) => {
  const v = parseFloat(s ?? '')
  return Number.isFinite(v) ? v : 0
}

const norm = (a: number) => ((a % 360) + 360) % 360

function pairs(s: string | undefined): [number, number][] {
  if (!s) return []
  const t = s.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite)
  const out: [number, number][] = []
  for (let i = 0; i + 1 < t.length; i += 2) out.push([t[i], t[i + 1]])
  return out
}

function rotate(p: P, deg: number): P {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4

/** EasyEDA escapes some characters in pad numbers and pin names ("1&#96;"). */
const unescape = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCharCode(parseInt(c, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

/** End points of an SVG path's M/L/A commands (arc radii and flags are not points). */
function pathPoints(d: string): [number, number][] {
  const out: [number, number][] = []
  const toks = d.match(/[MLAZHVmlazhv]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  let cmd = 'M'
  let i = 0
  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) {
      cmd = toks[i++].toUpperCase()
      continue
    }
    const take = cmd === 'A' ? 7 : cmd === 'H' || cmd === 'V' ? 1 : cmd === 'Z' ? 0 : 2
    if (!take) {
      i++
      continue
    }
    const v = toks.slice(i, i + take).map(Number)
    i += take
    if (v.length < take) break
    if (cmd === 'A') out.push([v[5], v[6]])
    else if (cmd === 'M' || cmd === 'L') out.push([v[0], v[1]])
  }
  return out
}

export function parsePart(raw: unknown): { footprint: Footprint; info: PartInfo } {
  const root = ((raw as { result?: Raw })?.result ?? raw) as Raw
  const ds = root.packageDetail?.dataStr
  const head = ds?.head
  if (!head || !Array.isArray(ds?.shape)) throw new Error('this part has no PCB footprint in the EasyEDA library')

  const ox = n(String(head.x ?? 0))
  const oy = n(String(head.y ?? 0))
  const conv = (x: number, y: number): P => ({ x: r4((x - ox) * UNIT), y: r4(-(y - oy) * UNIT) })

  const pads: Pad[] = []
  const silk: Footprint['silk'] = []
  const body: P[] = []
  const holes: { at: P; d: number }[] = []

  for (const line of ds!.shape!) {
    if (typeof line !== 'string') continue
    const f = line.split('~')
    try {
      switch (f[0]) {
        case 'PAD': {
          const rawShape = (f[1] ?? '').toUpperCase()
          const w = n(f[4])
          const h = n(f[5])
          const layerId = Math.round(n(f[6]))
          const holeR = n(f[9])
          const shape: Pad['shape'] =
            rawShape === 'ELLIPSE' ? (Math.abs(w - h) < 1e-6 ? 'circle' : 'oval') : rawShape === 'OVAL' ? 'oval' : rawShape === 'POLYGON' ? 'polygon' : 'rect'
          const at = conv(n(f[2]), n(f[3]))
          const pad: Pad = {
            number: unescape((f[8] ?? '').trim()),
            shape,
            at,
            rotation: norm(-n(f[11])),
            w: r4(w * UNIT),
            h: r4(h * UNIT),
            layer: layerId === LAYER_MULTI ? 'through' : layerId === LAYER_BOTTOM ? 'bottom' : 'top',
          }
          if (shape === 'polygon') {
            pad.polygon = pairs(f[10]).map(([x, y]) => {
              const p = conv(x, y)
              const q = rotate({ x: p.x - at.x, y: p.y - at.y }, -pad.rotation)
              return { x: r4(q.x), y: r4(q.y) }
            })
          }
          if (holeR > 0 && 2 * holeR * UNIT >= 0.05 && layerId === LAYER_MULTI) {
            pad.drill = { d: r4(2 * holeR * UNIT), plated: (f[15] ?? 'Y').trim().toUpperCase() !== 'N' }
            if (n(f[13]) > 0) pad.drill.slot = r4(n(f[13]) * UNIT)
            const ends = pairs(f[14] ?? '')
            if (ends.length === 2) pad.drill.ends = ends.map(([x, y]) => {
              const p = conv(x, y)
              const q = rotate({ x: p.x - at.x, y: p.y - at.y }, -pad.rotation)
              return { x: r4(q.x), y: r4(q.y) }
            }) as [P, P]
          }
          pads.push(pad)
          break
        }
        case 'TRACK': {
          const layer = Math.round(n(f[2]))
          const pts = pairs(f[4]).map(([x, y]) => conv(x, y))
          if (layer === SILK_TOP) {
            const width = r4(n(f[1]) * UNIT)
            for (let i = 0; i + 1 < pts.length; i++) silk.push([pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, width])
          } else if (BODY_LAYERS.has(layer)) body.push(...pts)
          break
        }
        case 'CIRCLE': {
          if (Math.round(n(f[5])) !== SILK_TOP) break
          const c = conv(n(f[1]), n(f[2]))
          const r = n(f[3]) * UNIT
          const width = r4(n(f[4]) * UNIT)
          for (let i = 0; i < 16; i++) {
            const a0 = (i / 16) * 2 * Math.PI
            const a1 = ((i + 1) / 16) * 2 * Math.PI
            silk.push([r4(c.x + r * Math.cos(a0)), r4(c.y + r * Math.sin(a0)), r4(c.x + r * Math.cos(a1)), r4(c.y + r * Math.sin(a1)), width])
          }
          break
        }
        case 'SOLIDREGION': {
          if (!BODY_LAYERS.has(Math.round(n(f[1])))) break
          for (const [x, y] of pathPoints(f[3] ?? '')) body.push(conv(x, y))
          break
        }
        case 'HOLE': {
          const r = n(f[3])
          if (r > 0) holes.push({ at: conv(n(f[1]), n(f[2])), d: r4(2 * r * UNIT) })
          break
        }
      }
    } catch {
      if (f[0] === 'PAD') throw new Error(`could not read pad: ${line.slice(0, 60)}`)
    }
  }
  if (!pads.length) throw new Error('the footprint has no pads')

  // Courtyard: bounding box of pads and body, grown by 0.25 mm.
  const xs: number[] = []
  const ys: number[] = []
  for (const p of pads) {
    const ext = Math.max(p.w, p.h) / 2
    xs.push(p.at.x - ext, p.at.x + ext)
    ys.push(p.at.y - ext, p.at.y + ext)
  }
  for (const p of body) {
    xs.push(p.x)
    ys.push(p.y)
  }
  const g = 0.25
  const [x0, x1, y0, y1] = [Math.min(...xs) - g, Math.max(...xs) + g, Math.min(...ys) - g, Math.max(...ys) + g]
  const courtyard = [
    { x: r4(x0), y: r4(y0) },
    { x: r4(x1), y: r4(y0) },
    { x: r4(x1), y: r4(y1) },
    { x: r4(x0), y: r4(y1) },
  ]

  // Pin names from the symbol: P~show~0~<num>~... with the name in the 4th
  // segment and the number in the 5th.
  const pins: Record<string, string> = {}
  for (const line of root.dataStr?.shape ?? []) {
    if (typeof line !== 'string' || !line.startsWith('P~')) continue
    const segs = line.split('^^')
    const num = unescape((segs[4]?.split('~')[4] ?? segs[0].split('~')[3] ?? '').trim())
    const name = unescape((segs[3]?.split('~')[4] ?? '').trim())
    if (num && name) pins[num] = name
  }

  const sym = root.dataStr?.head?.c_para ?? {}
  const pkg = root.packageDetail?.dataStr?.head?.c_para ?? {}
  const lcscObj = root.lcsc ?? root.szlcsc ?? {}
  const info: PartInfo = {
    lcsc: lcscObj.number ?? sym['Supplier Part'] ?? '',
    mpn: sym['Manufacturer Part'] ?? root.title ?? '',
    mfr: sym['Manufacturer'] ?? '',
    package: sym['package'] ?? pkg['package'] ?? '',
    description: root.description ?? '',
    basic: sym['JLCPCB Part Class'] === 'Basic Part',
  }
  if (typeof lcscObj.stock === 'number') info.stock = lcscObj.stock
  const link = pkg['link'] ?? sym['link']
  if (link && /^https?:\/\//.test(link)) info.datasheet = link

  const model = parseModel(ds!.shape!, ox, oy)
  const symbol = parseSymbol(root.dataStr as { head?: { x?: number | string; y?: number | string }; shape?: string[] } | undefined)

  return {
    footprint: {
      name: pkg['package'] ?? root.packageDetail?.title ?? info.package,
      pads,
      silk,
      courtyard,
      ...(holes.length ? { holes } : {}),
      pins,
      height: guessHeight(info.package),
      ...(model ? { model } : {}),
      ...(symbol ? { symbol } : {}),
    },
    info,
  }
}

/**
 * The 3D model reference from the footprint's outline3D SVGNODE. The
 * projection outline's center is used as the anchor: c_origin is often
 * stale (Flamingo found parts off by up to ~900 mm).
 */
function parseModel(shapes: string[], ox: number, oy: number): Model3D | undefined {
  for (const line of shapes) {
    if (typeof line !== 'string' || !line.startsWith('SVGNODE~')) continue
    let node: { attrs?: Record<string, string>; childNodes?: { attrs?: Record<string, string> }[] }
    try {
      node = JSON.parse(line.slice(8))
    } catch {
      continue
    }
    const a = node.attrs
    if (!a || a.c_etype !== 'outline3D') continue
    const uuid = (a.uuid ?? '').trim().toLowerCase()
    if (!/^[0-9a-f]{32}$/.test(uuid)) continue
    let anchor: { x: number; y: number } | undefined
    const xs: number[] = []
    const ys: number[] = []
    for (const ch of node.childNodes ?? []) {
      const pts = pairs(ch.attrs?.points)
      for (const [x, y] of pts) {
        xs.push(x)
        ys.push(y)
      }
    }
    if (xs.length) anchor = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
    if (!anchor) {
      const [cx, cy] = (a.c_origin ?? '').split(',').map(Number)
      anchor = { x: Number.isFinite(cx) ? cx : ox, y: Number.isFinite(cy) ? cy : oy }
    }
    const rot = (a.c_rotation ?? '0,0,0').split(',').map((v) => n(v)) as [number, number, number]
    return {
      uuid,
      origin: { x: r4((anchor.x - ox) * UNIT), y: r4(-(anchor.y - oy) * UNIT) },
      z: r4(n(a.z) * UNIT),
      rotation: [rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0],
    }
  }
  return undefined
}

/** Rough body height from the package name, for 3D and enclosure fits. */
function guessHeight(pkg: string): number {
  const p = pkg.toUpperCase()
  if (/^(0201|0402)/.test(p)) return 0.35
  if (/^0603/.test(p)) return 0.5
  if (/^(0805|1206)/.test(p)) return 0.7
  if (/SOT-23|SOD-123|SOD-323/.test(p)) return 1.1
  if (/SOT-223/.test(p)) return 1.8
  if (/SOP|SOIC|TSSOP|MSOP/.test(p)) return 1.6
  if (/QFN|DFN|LGA/.test(p)) return 0.9
  if (/QFP/.test(p)) return 1.5
  if (/USB|TYPE-C/.test(p)) return 3.3
  if (/HDR|HEADER|PIN/.test(p)) return 8.5
  return 1.5
}

/**
 * The schematic symbol: body rectangles (R~x~y~rx~ry~w~h), ellipses
 * (E~cx~cy~rx~ry) and pins (P~show~type~number~x~y~rotation~id^^...^^path
 * ^^name...^^number...). Coordinates are relative to the symbol origin; the
 * pin's x/y is its outer end, where wires connect.
 */
function parseSymbol(ds: { head?: { x?: number | string; y?: number | string }; shape?: string[] } | undefined): SymbolDef | undefined {
  if (!ds?.shape?.length) return undefined
  const ox = n(String(ds.head?.x ?? 0))
  const oy = n(String(ds.head?.y ?? 0))
  const sym: SymbolDef = { rects: [], circles: [], pins: [], lines: [] }
  for (const line of ds.shape) {
    if (typeof line !== 'string') continue
    const f = line.split('~')
    if (f[0] === 'R') sym.rects.push([n(f[1]) - ox, n(f[2]) - oy, n(f[5]), n(f[6])])
    else if (f[0] === 'E') sym.circles.push([n(f[1]) - ox, n(f[2]) - oy, n(f[3])])
    else if (f[0] === 'PL' || f[0] === 'PG') {
      // Polyline / polygon body drawing: switch contacts, diode triangles, arrows.
      const v = (f[1] ?? '').trim().split(/[\s,]+/).map(Number)
      const pts: number[] = []
      for (let i = 0; i + 1 < v.length; i += 2) if (Number.isFinite(v[i]) && Number.isFinite(v[i + 1])) pts.push(v[i] - ox, v[i + 1] - oy)
      if (f[0] === 'PG' && pts.length >= 4) pts.push(pts[0], pts[1])
      if (pts.length >= 4) sym.lines!.push(pts)
    } else if (f[0] === 'PT') {
      // Path (M/L/A): straight pieces are enough for the outline.
      const pts: number[] = []
      for (const [x, y] of pathPoints(f[1] ?? '')) pts.push(x - ox, y - oy)
      if (pts.length >= 4) sym.lines!.push(pts)
    }
    else if (f[0] === 'P') {
      const segs = line.split('^^')
      const head = segs[0].split('~')
      const number = unescape((segs[4]?.split('~')[4] ?? head[3] ?? '').trim())
      const name = unescape((segs[3]?.split('~')[4] ?? '').trim())
      // Pin line path "M x y h ±L" or "v ±L": its length and direction.
      const path = segs[2]?.split('~')[0] ?? ''
      const m = /M\s*([-\d.]+)[ ,]+([-\d.]+)\s*([hv])\s*([-\d.]+)/i.exec(path)
      const len = m ? Math.abs(Number(m[4])) : 10
      // The line runs from the pin end into the body; the pin points the other way.
      let dir = 0
      if (m) {
        const d = Number(m[4])
        if (m[3].toLowerCase() === 'h') dir = d > 0 ? 180 : 0
        else dir = d > 0 ? 270 : 90
      }
      sym.pins.push({ number, name: name || number, x: n(head[4]) - ox, y: n(head[5]) - oy, dir, length: len })
    }
  }
  if (!sym.pins.length) return undefined
  if (!sym.lines!.length) delete sym.lines
  // Packages with no body drawing get a box around the pins' inner ends.
  if (!sym.rects.length && !sym.circles.length && !sym.lines) {
    const xs = sym.pins.map((p) => p.x)
    const ys = sym.pins.map((p) => p.y)
    sym.rects.push([Math.min(...xs) + 10, Math.min(...ys) - 5, Math.max(Math.max(...xs) - Math.min(...xs) - 20, 10), Math.max(...ys) - Math.min(...ys) + 10])
  }
  return sym
}
