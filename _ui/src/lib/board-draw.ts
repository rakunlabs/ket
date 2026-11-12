// 2D board drawing on a canvas: used by the PCB view and by render_board.

import type { Pcb } from '../engine/doc'
import type { BoardState } from '../engine/pcb/state'
import { boardStyle } from '../engine/pcb/artwork'
import { drillRing } from '../engine/pcb/drills'

export interface View {
  /** px per mm */
  scale: number
  /** board coordinate at the canvas center */
  cx: number
  cy: number
}

export interface DrawOptions {
  side: 'top' | 'bottom'
  ratsnest: boolean
  highlight?: Set<string>
  violations?: { at?: [number, number] }[]
  selected?: string
  grid?: boolean
}

// The board view is dark in both themes, like every EDA tool: copper and
// silk read best on it. Warm neutrals from the app palette; copper layers in
// the KiCad convention (top red, bottom blue) so they read at a glance;
// selection in the app's highlight yellow, DRC in its danger red.
const COLORS = {
  bg: '#121210',
  board: '#1d3324',
  edge: '#fbff81',
  padTop: '#c9a64a',
  padBottom: '#6f93c9',
  trackTop: '#c8584a',
  trackBottom: '#4f7cc4',
  via: '#b4b4ae',
  silk: '#e8e8e4',
  rats: '#e8e8e4aa',
  hl: '#fbff81',
  drc: '#f0817b',
  hole: '#0b0b0a',
}

export function fitView(st: BoardState, w: number, h: number): View {
  const pts = st.board.outline.length ? st.board.outline : [{ x: -10, y: -10 }, { x: 10, y: 10 }]
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const bw = Math.max(...xs) - Math.min(...xs) || 20
  const bh = Math.max(...ys) - Math.min(...ys) || 20
  const scale = Math.min(w / (bw * 1.15), h / (bh * 1.15))
  return { scale, cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 }
}

export function drawBoard(ctx: CanvasRenderingContext2D, w: number, h: number, pcb: Pcb, st: BoardState, view: View, o: DrawOptions) {
  const flip = o.side === 'bottom' ? -1 : 1
  const X = (x: number) => w / 2 + (x - view.cx) * view.scale * flip
  const Y = (y: number) => h / 2 - (y - view.cy) * view.scale
  const s = view.scale
  const style = boardStyle(pcb)

  ctx.save()
  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, w, h)

  const path = (poly: { x: number; y: number }[]) => {
    ctx.beginPath()
    poly.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))))
    ctx.closePath()
  }

  const b = st.board
  if (b.outline.length) {
    path(b.outline)
    ctx.fillStyle = style.maskColor
    ctx.fill()
    for (const c of b.cutouts) {
      path(c)
      ctx.fillStyle = COLORS.bg
      ctx.fill()
    }
  }

  if (o.grid !== false && s > 4) {
    ctx.strokeStyle = '#e8e8e410'
    ctx.lineWidth = 1
    const step = s > 25 ? 1 : s > 8 ? 5 : 10
    const x0 = view.cx - w / 2 / s
    const x1 = view.cx + w / 2 / s
    const y0 = view.cy - h / 2 / s
    const y1 = view.cy + h / 2 / s
    ctx.beginPath()
    for (let x = Math.ceil(x0 / step) * step; x < x1; x += step) {
      ctx.moveTo(X(x), 0)
      ctx.lineTo(X(x), h)
    }
    for (let y = Math.ceil(y0 / step) * step; y < y1; y += step) {
      ctx.moveTo(0, Y(y))
      ctx.lineTo(w, Y(y))
    }
    ctx.stroke()
  }

  const near = o.side === 'top' ? 'F.Cu' : 'B.Cu'
  const far = o.side === 'top' ? 'B.Cu' : 'F.Cu'
  const trackColor = (l: string) => (l === 'F.Cu' ? COLORS.trackTop : l === 'B.Cu' ? COLORS.trackBottom : '#9b59b6')
  const hl = o.highlight ?? new Set<string>()

  // Pours under everything, far layer fainter.
  for (const layer of [far, near]) {
    for (const z of st.zones ?? []) {
      if (z.layer !== layer) continue
      ctx.globalAlpha = layer === near ? 0.45 : 0.22
      ctx.fillStyle = hl.has(z.net) ? COLORS.hl : trackColor(layer)
      for (const reg of z.regions) {
        ctx.beginPath()
        for (const ring of reg) ring.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))))
        ctx.fill('evenodd')
      }
    }
  }
  ctx.globalAlpha = 1

  // Far layer first, faded.
  for (const layer of [far, 'In1.Cu', 'In2.Cu', near]) {
    ctx.globalAlpha = layer === near ? 1 : 0.55
    for (const t of pcb.tracks) {
      if (t.layer !== layer) continue
      ctx.strokeStyle = hl.has(t.net) ? COLORS.hl : trackColor(t.layer)
      ctx.lineWidth = Math.max(1, t.width * s)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      t.points.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))))
      ctx.stroke()
    }
    for (const p of b.pads) {
      if (!p.layers.includes(layer) || (p.layers.length > 1 && layer !== near)) continue
      path(p.outline)
      ctx.fillStyle = hl.has(p.ref) || (p.net && hl.has(p.net)) ? COLORS.hl : layer === 'F.Cu' ? COLORS.padTop : COLORS.padBottom
      ctx.fill()
      if (p.drill) {
        path(drillRing({ from: p.drillSlot?.[0] ?? p.center, to: p.drillSlot?.[1] ?? p.center, d: p.drill }))
        ctx.fillStyle = COLORS.hole
        ctx.fill()
      }
    }
  }
  ctx.globalAlpha = 1

  for (const v of pcb.vias) {
    ctx.beginPath()
    ctx.arc(X(v.at[0]), Y(v.at[1]), (v.diameter / 2) * s, 0, Math.PI * 2)
    ctx.fillStyle = hl.has(v.net) ? COLORS.hl : COLORS.via
    ctx.fill()
    ctx.beginPath()
    ctx.arc(X(v.at[0]), Y(v.at[1]), (v.drill / 2) * s, 0, Math.PI * 2)
    ctx.fillStyle = COLORS.hole
    ctx.fill()
  }
  for (const hole of b.holes) {
    ctx.beginPath()
    ctx.arc(X(hole.at.x), Y(hole.at.y), (hole.d / 2) * s, 0, Math.PI * 2)
    ctx.fillStyle = COLORS.hole
    ctx.fill()
    ctx.strokeStyle = COLORS.edge
    ctx.lineWidth = 1
    ctx.stroke()
  }

  // Silk and refs of this side.
  for (const c of b.components) {
    if (c.side !== o.side) continue
    const selected = o.selected === c.ref || hl.has(c.ref)
    ctx.strokeStyle = selected ? COLORS.hl : style.silkColor + '99'
    ctx.lineWidth = selected ? 2 : 1
    path(c.courtyard)
    ctx.setLineDash([3, 3])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.strokeStyle = style.silkColor
    ctx.lineWidth = Math.max(1, 0.12 * s)
    for (const [x1, y1, x2, y2] of c.footprint.silk) {
      const a = (c.rotation * Math.PI) / 180
      const m = (x: number, y: number) => {
        const xx = c.side === 'bottom' ? -x : x
        return [c.at.x + xx * Math.cos(a) - y * Math.sin(a), c.at.y + xx * Math.sin(a) + y * Math.cos(a)]
      }
      const [ax, ay] = m(x1, y1)
      const [bx, by] = m(x2, y2)
      ctx.beginPath()
      ctx.moveTo(X(ax), Y(ay))
      ctx.lineTo(X(bx), Y(by))
      ctx.stroke()
    }
    const fs = Math.max(10, Math.min(16, 1.2 * s))
    ctx.font = `600 ${fs}px ui-monospace, monospace`
    ctx.fillStyle = selected ? COLORS.hl : style.silkColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(c.ref, X(c.at.x), Y(c.at.y))
  }

  ctx.fillStyle = style.silkColor
  for (const art of b.artwork ?? []) {
    if (art.side !== o.side) continue
    for (const region of art.regions) {
      ctx.beginPath()
      for (const ring of region) {
        ring.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))))
        ctx.closePath()
      }
      ctx.fill('evenodd')
    }
  }

  if (b.outline.length) {
    for (const poly of [b.outline, ...b.cutouts]) {
      path(poly)
      ctx.strokeStyle = COLORS.edge
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }

  if (o.ratsnest) {
    ctx.strokeStyle = COLORS.rats
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    for (const l of st.ratsnest.lines) {
      ctx.beginPath()
      ctx.moveTo(X(l.a[0]), Y(l.a[1]))
      ctx.lineTo(X(l.b[0]), Y(l.b[1]))
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  for (const v of o.violations ?? []) {
    if (!v.at) continue
    ctx.strokeStyle = COLORS.drc
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(X(v.at[0]), Y(v.at[1]), 8, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(X(v.at[0]) - 5, Y(v.at[1]) - 5)
    ctx.lineTo(X(v.at[0]) + 5, Y(v.at[1]) + 5)
    ctx.moveTo(X(v.at[0]) + 5, Y(v.at[1]) - 5)
    ctx.lineTo(X(v.at[0]) - 5, Y(v.at[1]) + 5)
    ctx.stroke()
  }

  ctx.restore()
}

/** Board coordinate under a canvas pixel. */
export function toBoard(view: View, w: number, h: number, px: number, py: number, side: 'top' | 'bottom'): [number, number] {
  const flip = side === 'bottom' ? -1 : 1
  return [view.cx + ((px - w / 2) / view.scale) * flip, view.cy - (py - h / 2) / view.scale]
}

export async function renderBoardPNG(pcb: Pcb, st: BoardState, size: number, o: DrawOptions): Promise<string> {
  const canvas = document.createElement('canvas')
  const xs = st.board.outline.map((p) => p.x)
  const ys = st.board.outline.map((p) => p.y)
  const aspect = xs.length ? (Math.max(...ys) - Math.min(...ys)) / (Math.max(...xs) - Math.min(...xs) || 1) : 1
  canvas.width = size
  canvas.height = Math.max(200, Math.round(size * Math.min(1.5, Math.max(0.4, aspect))))
  const ctx = canvas.getContext('2d')!
  drawBoard(ctx, canvas.width, canvas.height, pcb, st, fitView(st, canvas.width, canvas.height), o)
  const url = canvas.toDataURL('image/png')
  return url.slice(url.indexOf(',') + 1)
}
