// 2D technical drawings and flat exports: views of bodies by hidden-line
// projection (visible and hidden edges as polylines in mm), laid out in
// third-angle order with overall dimensions, written as SVG, PDF or DXF.
// Everything here is plain geometry and text: no canvas, deterministic.

export type P2 = [number, number]
/** One polyline of a view, in view coordinates (mm, y up). */
export type Line = P2[]

export interface View {
  name: 'front' | 'top' | 'right' | 'left' | 'back' | 'bottom' | 'iso' | string
  visible: Line[]
  hidden: Line[]
  /** View-space box of the visible lines. */
  box: [P2, P2]
}

export interface Dimension {
  /** Ends of the measured span on the sheet (mm), and the text. */
  a: P2
  b: P2
  /** Offset of the dimension line from a–b, perpendicular, on the sheet (mm). */
  offset: number
  text: string
}

export interface Sheet {
  title: string
  /** Sheet size in mm (A4 landscape by default). */
  width: number
  height: number
  /** Drawing scale: sheet mm per model mm. */
  scale: number
  views: (View & { at: P2 })[]
  dimensions: Dimension[]
  notes: string[]
}

/** Parses replicad's SVG path data ("M x y L x y ... Z", "A" arcs sampled) into polylines; y flipped to point up. */
export function pathsToLines(paths: string[], flipY = true): Line[] {
  const out: Line[] = []
  for (const d of paths) {
    const tok = d.match(/[MLAZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
    let cur: Line = []
    let start: P2 | undefined
    let i = 0
    const n = () => Number(tok[i++])
    const pt = (x: number, y: number): P2 => [x, flipY ? -y : y]
    while (i < tok.length) {
      const c = tok[i++].toUpperCase()
      if (c === 'M') {
        if (cur.length > 1) out.push(cur)
        const p = pt(n(), n())
        cur = [p]
        start = p
      } else if (c === 'L') {
        cur.push(pt(n(), n()))
      } else if (c === 'A') {
        const rx = n()
        n() // ry (circular arcs only from replicad)
        n() // x-axis rotation
        const large = n()
        const sweep = n()
        const to = pt(n(), n())
        const from = cur[cur.length - 1]
        cur.push(...arcPoints(from, to, rx, !!large, flipY ? !sweep : !!sweep))
      } else if (c === 'Z') {
        if (start) cur.push(start)
      }
    }
    if (cur.length > 1) out.push(cur)
  }
  return out
}

/** Points of a circular SVG arc from a to b (excluding a), about every 5°. */
function arcPoints(a: P2, b: P2, r: number, large: boolean, sweep: boolean): P2[] {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const d = Math.hypot(dx, dy)
  if (d < 1e-9) return []
  r = Math.max(r, d / 2)
  const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4))
  const mx = (a[0] + b[0]) / 2
  const my = (a[1] + b[1]) / 2
  // Center on the side that gives the requested arc.
  const s = large === sweep ? -1 : 1
  const cx = mx + (s * h * -dy) / d
  const cy = my + (s * h * dx) / d
  let t0 = Math.atan2(a[1] - cy, a[0] - cx)
  let t1 = Math.atan2(b[1] - cy, b[0] - cx)
  if (sweep && t1 <= t0) t1 += 2 * Math.PI
  if (!sweep && t1 >= t0) t1 -= 2 * Math.PI
  const steps = Math.max(2, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 36)))
  const out: P2[] = []
  for (let k = 1; k <= steps; k++) {
    const t = t0 + ((t1 - t0) * k) / steps
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)])
  }
  out[out.length - 1] = b
  void t0
  return out
}

export function boxOf(lines: Line[]): [P2, P2] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const l of lines)
    for (const [x, y] of l) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  if (!Number.isFinite(x0)) return [[0, 0], [0, 0]]
  return [[x0, y0], [x1, y1]]
}

const r2 = (v: number) => Math.round(v * 100) / 100
const fmt = (v: number) => {
  const s = r2(v).toFixed(2)
  return s.replace(/\.?0+$/, '')
}

/** Standard paper sizes (landscape), mm. */
export const PAPER = { A4: [297, 210], A3: [420, 297], A2: [594, 420] } as const

/** Preferred drawing scales (sheet : model). */
const SCALES = [10, 5, 4, 2, 1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.02, 0.01]

/**
 * Lays views out on a sheet (third-angle: top above front, right to the
 * right of front, iso in the free corner), picks the largest standard
 * scale that fits, and adds overall dimensions of front (width, height)
 * and top or right (depth).
 */
export function layoutSheet(views: View[], opts: { title: string; paper?: keyof typeof PAPER; scale?: number; notes?: string[] }): Sheet {
  const [W, H] = PAPER[opts.paper ?? 'A4']
  const margin = 15
  const titleH = 18
  const gap = 18
  const get = (n: string) => views.find((v) => v.name === n)
  const size = (v?: View): P2 => (v ? [v.box[1][0] - v.box[0][0], v.box[1][1] - v.box[0][1]] : [0, 0])
  const front = get('front')
  const top = get('top')
  const right = get('right')
  const iso = get('iso')
  const rest = views.filter((v) => !['front', 'top', 'right', 'iso'].includes(v.name))
  // Grid: column 0 front/top, column 1 right/iso; extra views in a third column.
  const colW = [Math.max(size(front)[0], size(top)[0]), Math.max(size(right)[0], size(iso)[0]), Math.max(0, ...rest.map((v) => size(v)[0]))]
  const rowH = [Math.max(size(top)[1], size(iso)[1]), Math.max(size(front)[1], size(right)[1], ...rest.map((v) => size(v)[1]))]
  const usedCols = colW.filter((w) => w > 0).length
  const usedRows = rowH.filter((h) => h > 0).length
  const availW = W - 2 * margin - gap * Math.max(0, usedCols - 1) - 20
  const availH = H - 2 * margin - titleH - gap * Math.max(0, usedRows - 1) - 20
  const totalW = colW.reduce((s, w) => s + w, 0) || 1
  const totalH = rowH.reduce((s, h) => s + h, 0) || 1
  const fit = Math.min(availW / totalW, availH / totalH)
  const scale = opts.scale ?? SCALES.find((s) => s <= fit) ?? SCALES[SCALES.length - 1]
  const placed: Sheet['views'] = []
  // Sheet coordinates: origin bottom-left, y up (PDF / DXF convention); SVG flips.
  const x0 = margin + 10
  const yTop = H - margin - 10
  const colX = [x0, x0 + colW[0] * scale + (colW[0] ? gap : 0), 0]
  colX[2] = colX[1] + colW[1] * scale + (colW[1] ? gap : 0)
  const rowY = [yTop - rowH[0] * scale, yTop - rowH[0] * scale - (rowH[0] ? gap : 0) - rowH[1] * scale]
  const put = (v: View | undefined, col: number, row: number) => {
    if (!v) return
    const [w, h] = size(v)
    // Center each view in its cell; front and top share x, front and right share y (projection alignment).
    const cx = colX[col] + (colW[col] * scale) / 2
    const cy = rowY[row] + (rowH[row] * scale) / 2
    placed.push({ ...v, at: [cx - (v.box[0][0] + w / 2) * scale, cy - (v.box[0][1] + h / 2) * scale] })
  }
  put(top, 0, 0)
  put(iso, 1, 0)
  put(front, 0, 1)
  put(right, 1, 1)
  rest.forEach((v) => put(v, 2, 1))

  const dims: Dimension[] = []
  const at = (v: View) => placed.find((p) => p.name === v.name)!.at
  const sheetPt = (v: View, p: P2): P2 => [at(v)[0] + p[0] * scale, at(v)[1] + p[1] * scale]
  if (front) {
    const [lo, hi] = front.box
    dims.push({ a: sheetPt(front, [lo[0], lo[1]]), b: sheetPt(front, [hi[0], lo[1]]), offset: -8, text: fmt(hi[0] - lo[0]) })
    dims.push({ a: sheetPt(front, [lo[0], lo[1]]), b: sheetPt(front, [lo[0], hi[1]]), offset: 8, text: fmt(hi[1] - lo[1]) })
  }
  const depthView = right ?? top
  if (depthView) {
    const [lo, hi] = depthView.box
    if (depthView === right) dims.push({ a: sheetPt(right, [lo[0], lo[1]]), b: sheetPt(right, [hi[0], lo[1]]), offset: -8, text: fmt(hi[0] - lo[0]) })
    else dims.push({ a: sheetPt(top!, [hi[0], lo[1]]), b: sheetPt(top!, [hi[0], hi[1]]), offset: -8, text: fmt(hi[1] - lo[1]) })
  }
  return { title: opts.title, width: W, height: H, scale, views: placed, dimensions: dims, notes: opts.notes ?? [] }
}

const scaleText = (s: number) => (s >= 1 ? `${fmt(s)}:1` : `1:${fmt(1 / s)}`)

/** Sheet geometry as polylines in sheet mm, by layer: what SVG, PDF and DXF all draw. */
export interface SheetGeometry {
  visible: Line[]
  hidden: Line[]
  thin: Line[]
  texts: { at: P2; size: number; text: string; anchor: 'start' | 'middle' | 'end'; angle?: number }[]
}

export function sheetGeometry(s: Sheet): SheetGeometry {
  const g: SheetGeometry = { visible: [], hidden: [], thin: [], texts: [] }
  const tr = (v: Sheet['views'][number], l: Line): Line => l.map(([x, y]) => [v.at[0] + x * s.scale, v.at[1] + y * s.scale])
  for (const v of s.views) {
    g.visible.push(...v.visible.map((l) => tr(v, l)))
    g.hidden.push(...v.hidden.map((l) => tr(v, l)))
    const [lo, hi] = [tr(v, [v.box[0]])[0], tr(v, [v.box[1]])[0]]
    g.texts.push({ at: [(lo[0] + hi[0]) / 2, Math.min(lo[1], hi[1]) - (v.name === 'front' || v.name === 'right' ? 16 : 5)], size: 3, text: v.name.toUpperCase(), anchor: 'middle' })
  }
  for (const d of s.dimensions) {
    const dx = d.b[0] - d.a[0]
    const dy = d.b[1] - d.a[1]
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny = dx / len
    const a: P2 = [d.a[0] + nx * d.offset, d.a[1] + ny * d.offset]
    const b: P2 = [d.b[0] + nx * d.offset, d.b[1] + ny * d.offset]
    const ext = Math.sign(d.offset) * 1.5
    g.thin.push([d.a, [a[0] + nx * ext, a[1] + ny * ext]], [d.b, [b[0] + nx * ext, b[1] + ny * ext]], [a, b])
    // Arrowheads 2.5 mm long, 15°.
    const ux = dx / len
    const uy = dy / len
    const head = (p: P2, s2: number): Line => [[p[0] + s2 * (ux * 2.5 + nx * 0.7), p[1] + s2 * (uy * 2.5 + ny * 0.7)], p, [p[0] + s2 * (ux * 2.5 - nx * 0.7), p[1] + s2 * (uy * 2.5 - ny * 0.7)]]
    g.thin.push(head(a, 1), head(b, -1))
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI
    const side = Math.sign(d.offset) || 1
    g.texts.push({ at: [(a[0] + b[0]) / 2 + nx * 1.2 * side, (a[1] + b[1]) / 2 + ny * 1.2 * side], size: 3.5, text: d.text, anchor: 'middle', angle: Math.abs(angle) > 90 ? angle - 180 : angle })
  }
  // Frame and title block.
  const m = 10
  const W = s.width
  const H = s.height
  g.visible.push([[m, m], [W - m, m], [W - m, H - m], [m, H - m], [m, m]])
  const bw = 120
  const bh = 18
  g.visible.push([[W - m - bw, m], [W - m - bw, m + bh], [W - m, m + bh]])
  g.thin.push([[W - m - bw, m + bh / 2], [W - m, m + bh / 2]], [[W - m - 30, m], [W - m - 30, m + bh / 2]])
  g.texts.push({ at: [W - m - bw + 3, m + bh / 2 + 3], size: 5, text: s.title, anchor: 'start' })
  g.texts.push({ at: [W - m - bw + 3, m + 3], size: 3, text: 'Dimensions in mm. Third-angle projection. Ket', anchor: 'start' })
  g.texts.push({ at: [W - m - 15, m + 3], size: 3.5, text: scaleText(s.scale), anchor: 'middle' })
  s.notes.forEach((n, i) => g.texts.push({ at: [m + 4, m + 4 + i * 5], size: 3, text: n, anchor: 'start' }))
  return g
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The sheet as SVG in mm (y flipped for SVG). */
export function sheetSVG(s: Sheet): string {
  const g = sheetGeometry(s)
  const H = s.height
  const pts = (l: Line) => l.map(([x, y]) => `${r2(x)},${r2(H - y)}`).join(' ')
  const poly = (ls: Line[], cls: string) => ls.map((l) => `<polyline class="${cls}" points="${pts(l)}"/>`).join('\n')
  const texts = g.texts
    .map((t) => {
      const x = r2(t.at[0])
      const y = r2(H - t.at[1])
      const rot = t.angle ? ` transform="rotate(${r2(-t.angle)} ${x} ${y})"` : ''
      return `<text x="${x}" y="${y}" font-size="${t.size}" text-anchor="${t.anchor}"${rot}>${esc(t.text)}</text>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}mm" height="${s.height}mm" viewBox="0 0 ${s.width} ${s.height}">
<style>polyline{fill:none;stroke:#000;stroke-linejoin:round;stroke-linecap:round}.v{stroke-width:0.5}.h{stroke-width:0.25;stroke-dasharray:2 1}.t{stroke-width:0.18}text{font-family:"IBM Plex Sans",Arial,sans-serif;fill:#000}</style>
<rect width="100%" height="100%" fill="#fff"/>
${poly(g.visible, 'v')}
${poly(g.hidden, 'h')}
${poly(g.thin, 't')}
${texts}
</svg>
`
}

/** The sheet as a one-page vector PDF (Helvetica text; no dependencies). */
export function sheetPDF(s: Sheet): Uint8Array {
  const g = sheetGeometry(s)
  const k = 72 / 25.4
  const P = (v: number) => r2(v * k).toString()
  const lines: string[] = ['1 J 1 j']
  const stroke = (ls: Line[], width: number, dash: string) => {
    lines.push(`${P(width)} w ${dash} d`)
    for (const l of ls) lines.push(l.map(([x, y], i) => `${P(x)} ${P(y)} ${i ? 'l' : 'm'}`).join(' ') + ' S')
  }
  stroke(g.visible, 0.5, '[] 0')
  stroke(g.hidden, 0.25, `[${P(2)} ${P(1)}] 0`)
  stroke(g.thin, 0.18, '[] 0')
  const pdfText = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?')
  for (const t of g.texts) {
    // Helvetica width ≈ 0.5 em per character: good enough to center or right-align.
    const w = t.text.length * t.size * 0.5
    const shift = t.anchor === 'middle' ? -w / 2 : t.anchor === 'end' ? -w : 0
    const a = ((t.angle ?? 0) * Math.PI) / 180
    const [c, sn] = [Math.cos(a), Math.sin(a)]
    const x = t.at[0] + shift * c
    const y = t.at[1] + shift * sn
    lines.push(`BT /F1 ${P(t.size)} Tf ${r2(c)} ${r2(sn)} ${r2(-sn)} ${r2(c)} ${P(x)} ${P(y)} Tm (${pdfText(t.text)}) Tj ET`)
  }
  const content = lines.join('\n')
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${P(s.width)} ${P(s.height)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/**
 * Polylines as an ASCII DXF (R12: LINE and POLYLINE entities, units mm),
 * by layer. R12 opens in every CAD and laser-cutter tool.
 */
export function writeDXF(layers: Record<string, Line[]>, texts: SheetGeometry['texts'] = []): string {
  const o: string[] = []
  const g = (code: number, v: string | number) => o.push(String(code), typeof v === 'number' ? String(r2(v * 100) / 100) : v)
  g(0, 'SECTION'), g(2, 'HEADER'), g(9, '$INSUNITS'), g(70, '4'), g(0, 'ENDSEC')
  g(0, 'SECTION'), g(2, 'TABLES'), g(0, 'TABLE'), g(2, 'LAYER'), g(70, String(Object.keys(layers).length))
  Object.keys(layers).forEach((name, i) => {
    g(0, 'LAYER'), g(2, name), g(70, '0'), g(62, String((i % 7) + 1)), g(6, name.includes('HIDDEN') ? 'DASHED' : 'CONTINUOUS')
  })
  g(0, 'ENDTAB'), g(0, 'ENDSEC')
  g(0, 'SECTION'), g(2, 'ENTITIES')
  for (const [layer, ls] of Object.entries(layers)) {
    for (const l of ls) {
      if (l.length === 2) {
        g(0, 'LINE'), g(8, layer), g(10, l[0][0]), g(20, l[0][1]), g(30, 0), g(11, l[1][0]), g(21, l[1][1]), g(31, 0)
        continue
      }
      const closed = l.length > 2 && Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) < 1e-6
      const pts = closed ? l.slice(0, -1) : l
      g(0, 'POLYLINE'), g(8, layer), g(66, '1'), g(70, closed ? '1' : '0')
      for (const [x, y] of pts) g(0, 'VERTEX'), g(8, layer), g(10, x), g(20, y), g(30, 0)
      g(0, 'SEQEND'), g(8, layer)
    }
  }
  for (const t of texts) {
    g(0, 'TEXT'), g(8, 'TEXT'), g(10, t.at[0]), g(20, t.at[1]), g(30, 0), g(40, t.size), g(1, t.text)
    if (t.angle) g(50, t.angle)
    if (t.anchor !== 'start') g(72, t.anchor === 'middle' ? '1' : '2'), g(11, t.at[0]), g(21, t.at[1]), g(31, 0)
  }
  g(0, 'ENDSEC'), g(0, 'EOF')
  return o.join('\n') + '\n'
}

/** The sheet as DXF: visible, hidden and dimension layers plus texts. */
export function sheetDXF(s: Sheet): string {
  const g = sheetGeometry(s)
  return writeDXF({ VISIBLE: g.visible, HIDDEN: g.hidden, DIMENSIONS: g.thin }, g.texts)
}
