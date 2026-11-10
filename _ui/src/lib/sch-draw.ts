// Draws a Schematic on a canvas (view and render_schematic).

import type { Schematic } from '../engine/pcb/schematic'

export interface SchView {
  scale: number
  ox: number
  oy: number
}

// Colours follow the theme (app.css --sch-*); renders for agents use the
// light set so they look the same whatever the user's theme.
const LIGHT = {
  bg: '#fdfdfb',
  grid: '#e6e6e0',
  body: '#50504b',
  fill: '#fbfcdc',
  pin: '#6b6b66',
  text: '#222220',
  pinText: '#222220',
  net: '#276e45',
  hl: '#c4372f',
}
type Palette = typeof LIGHT
let C: Palette = LIGHT

/** Reads the schematic palette from the current theme. */
export function themeSch() {
  const v = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
  C = { bg: v('--sch-bg'), grid: v('--sch-grid'), body: v('--sch-body'), fill: v('--sch-fill'), pin: v('--sch-pin'), text: v('--sch-text'), pinText: v('--sch-pintext'), net: v('--sch-net'), hl: v('--sch-hl') }
}

export function fitSch(s: Schematic, w: number, h: number): SchView {
  const scale = Math.min(w / s.width, h / s.height) * 0.95
  return { scale, ox: (w - s.width * scale) / 2, oy: (h - s.height * scale) / 2 }
}

export function drawSchematic(ctx: CanvasRenderingContext2D, w: number, h: number, sch: Schematic, v: SchView, highlight = new Set<string>()) {
  const X = (x: number) => v.ox + x * v.scale
  const Y = (y: number) => v.oy + y * v.scale
  const k = v.scale
  ctx.save()
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, w, h)

  if (k * 10 > 6) {
    ctx.fillStyle = C.grid
    for (let x = 0; x <= sch.width; x += 10)
      for (let y = 0; y <= sch.height; y += 10) ctx.fillRect(X(x) - 0.5, Y(y) - 0.5, 1, 1)
  }

  const font = (size: number, weight = 400) => `${weight} ${Math.max(7, size * k)}px 'IBM Plex Sans Variable', ui-sans-serif, system-ui, sans-serif`

  // Wires under the symbols.
  ctx.lineWidth = Math.max(1.2, 0.9 * k)
  ctx.lineJoin = 'round'
  for (const w of sch.wires) {
    ctx.strokeStyle = highlight.has(w.net) || highlight.has(`${w.a}|${w.b}`) ? C.hl : C.net
    ctx.beginPath()
    w.path.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))))
    ctx.stroke()
  }
  ctx.fillStyle = C.net
  for (const [x, y] of sch.junctions) {
    ctx.beginPath()
    ctx.arc(X(x), Y(y), Math.max(2, 1.6 * k), 0, Math.PI * 2)
    ctx.fill()
  }

  for (const s of sch.symbols) {
    const hl = highlight.has(s.ref)
    ctx.lineWidth = Math.max(1, 1.2 * k * 0.5)
    for (const [rx, ry, rw, rh] of s.def.rects) {
      ctx.fillStyle = C.fill
      ctx.fillRect(X(s.x + rx), Y(s.y + ry), rw * k, rh * k)
      ctx.strokeStyle = hl ? C.hl : C.body
      ctx.strokeRect(X(s.x + rx), Y(s.y + ry), rw * k, rh * k)
    }
    for (const [cx, cy, r] of s.def.circles) {
      ctx.beginPath()
      ctx.arc(X(s.x + cx), Y(s.y + cy), r * k, 0, Math.PI * 2)
      ctx.strokeStyle = hl ? C.hl : C.body
      ctx.stroke()
    }

    for (const p of s.def.pins) {
      const a = (p.dir * Math.PI) / 180
      // Pin end (where wires attach) and where it meets the body.
      const ex = s.x + p.x
      const ey = s.y + p.y
      const ix = ex - Math.cos(a) * p.length
      const iy = ey + Math.sin(a) * p.length
      ctx.strokeStyle = C.pin
      ctx.beginPath()
      ctx.moveTo(X(ix), Y(iy))
      ctx.lineTo(X(ex), Y(ey))
      ctx.stroke()

      // Pin name inside the body, number on the pin.
      ctx.fillStyle = C.pinText
      ctx.font = font(4.5)
      const horizontal = p.dir === 0 || p.dir === 180
      ctx.textBaseline = 'middle'
      if (horizontal) {
        ctx.textAlign = p.dir === 0 ? 'right' : 'left'
        if (p.name !== p.number) ctx.fillText(p.name, X(ix - Math.cos(a) * 2), Y(iy))
        ctx.textAlign = 'center'
        ctx.fillStyle = C.pin
        ctx.font = font(3.5)
        ctx.fillText(p.number, X((ix + ex) / 2), Y(ey - 2.5))
      }

      // Net label at the pin end.
      const net = s.labels[p.number] ? s.nets[p.number] : undefined
      if (net) {
        const nhl = highlight.has(net)
        ctx.font = font(5, 600)
        const tw = ctx.measureText(net).width / k + 4
        const dx = Math.cos(a)
        const dy = -Math.sin(a)
        const lx = ex + dx * 2
        const ly = ey + dy * 2
        ctx.strokeStyle = nhl ? C.hl : C.net
        ctx.fillStyle = nhl ? C.hl : C.net
        ctx.beginPath()
        ctx.arc(X(ex), Y(ey), Math.max(1.5, 1.2 * k), 0, Math.PI * 2)
        ctx.fill()
        if (horizontal) {
          const x0 = dx > 0 ? lx : lx - tw
          ctx.beginPath()
          ctx.moveTo(X(ex), Y(ey))
          ctx.lineTo(X(dx > 0 ? x0 : x0 + tw), Y(ey))
          ctx.stroke()
          ctx.strokeRect(X(x0), Y(ly - 3.5), tw * k, 7 * k)
          ctx.textAlign = 'center'
          ctx.fillText(net, X(x0 + tw / 2), Y(ly))
        } else {
          ctx.textAlign = 'center'
          ctx.textBaseline = dy > 0 ? 'top' : 'bottom'
          ctx.fillText(net, X(lx), Y(ly + dy * 2))
          ctx.textBaseline = 'middle'
        }
      }
    }

    // Ref and value above the body.
    const top = Math.min(...s.def.rects.map((r) => r[1]), ...s.def.circles.map((c) => c[1] - c[2]), ...s.def.pins.map((p) => p.y))
    ctx.fillStyle = hl ? C.hl : C.text
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.font = font(6, 700)
    const left = Math.min(...s.def.rects.map((r) => r[0]), 0)
    ctx.fillText(s.ref, X(s.x + left), Y(s.y + top - 2))
    const refW = ctx.measureText(s.ref + ' ').width
    ctx.font = font(5)
    ctx.fillStyle = C.pin
    ctx.fillText(s.value, X(s.x + left) + refW, Y(s.y + top - 2))
  }
  ctx.restore()
}

export function renderSchematicPNG(sch: Schematic, size: number): string {
  const live = C
  C = LIGHT
  try {
    return renderPNG(sch, size)
  } finally {
    C = live
  }
}

function renderPNG(sch: Schematic, size: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = Math.max(200, Math.round((size * sch.height) / sch.width))
  const ctx = canvas.getContext('2d')!
  drawSchematic(ctx, canvas.width, canvas.height, sch, fitSch(sch, canvas.width, canvas.height))
  const url = canvas.toDataURL('image/png')
  return url.slice(url.indexOf(',') + 1)
}
