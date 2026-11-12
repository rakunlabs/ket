// The same prepared ink polygons feed 2D, 3D, DRC and Gerber. No fonts,
// images or browser APIs are needed to replay or export a design.
import { Clipper, FillRule } from 'clipper2-js'

import type { BoardArtwork, MaskColor, P, Pcb } from '../doc'
import { num } from '../expr'
import { fromPaths, polygons, toPaths, union } from './poly'

export const MASK_COLORS: Record<MaskColor, { label: string; color: string }> = {
  green: { label: 'Green', color: '#1f5a35' },
  black: { label: 'Black', color: '#242629' },
  white: { label: 'White', color: '#e6e5dd' },
  blue: { label: 'Blue', color: '#1b467e' },
  red: { label: 'Red', color: '#8c292c' },
  purple: { label: 'Purple', color: '#613c83' },
  yellow: { label: 'Yellow', color: '#c5a631' },
}

export function boardStyle(pcb: Pcb) {
  const mask = pcb.style?.mask ?? 'green'
  const silk = pcb.style?.silk ?? 'white'
  return { mask, silk, maskColor: MASK_COLORS[mask].color, silkColor: silk === 'black' ? '#20211e' : '#f2f2ea' }
}

export interface ResolvedArtwork {
  name: string
  kind: BoardArtwork['kind']
  side: 'top' | 'bottom'
  at: [number, number]
  width: number
  regions: P[][][]
}

function inkRegions(rings: P[][]): P[][][] {
  const cleaned = rings.map((ring) => {
    const out: P[] = []
    for (const p of ring) {
      const last = out.at(-1)
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) out.push({ x: p.x || 0, y: p.y || 0 })
    }
    if (out.length > 1 && Math.hypot(out[0].x - out.at(-1)!.x, out[0].y - out.at(-1)!.y) < 1e-9) out.pop()
    return out
  }).filter((ring) => ring.length >= 3)
  return polygons(cleaned)
}

export function resolveArtwork(art: BoardArtwork, params: Map<string, number>): ResolvedArtwork {
  const width = num(art.width, params, `${art.name}.width`)
  if (width <= 0 || width > 500) throw new Error(`${art.name}: artwork width must be greater than 0 and at most 500 mm`)
  const at: [number, number] = [num(art.at[0], params, `${art.name}.x`), num(art.at[1], params, `${art.name}.y`)]
  const angle = num(art.rotation, params, `${art.name}.rotation`, 0) * Math.PI / 180
  const transform = (p: P): P => {
    // Readable when looking at that face; bottom is mirrored in world XY,
    // but never mirrored a second time when exporting bottom Gerber.
    const x = p.x * width * (art.side === 'bottom' ? -1 : 1), y = p.y * width
    return { x: at[0] + x * Math.cos(angle) - y * Math.sin(angle), y: at[1] + x * Math.sin(angle) + y * Math.cos(angle) }
  }
  return { name: art.name, kind: art.kind, side: art.side, at, width, regions: art.regions.map((region) => region.map((ring) => ring.map(transform))) }
}

/** Black pixels print; white/transparent pixels do not. Rows run top to bottom. */
export function bitmapRegions(rows: string[]): P[][][] {
  const w = rows[0]?.length ?? 0, h = rows.length
  if (!w || !h || w > 256 || h > 256 || rows.some((r) => r.length !== w || /[^.#]/.test(r))) throw new Error('image bitmap must be rectangular, at most 256 × 256, using # for ink and . for empty pixels')
  const spans: P[][] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rows[y][x] !== '#') continue
      const start = x
      while (x + 1 < w && rows[y][x + 1] === '#') x++
      const left = start / w - 0.5, right = (x + 1) / w - 0.5
      const top = (h / 2 - y) / w, bottom = (h / 2 - y - 1) / w
      spans.push([{ x: left, y: bottom }, { x: right, y: bottom }, { x: right, y: top }, { x: left, y: top }])
    }
  }
  if (!spans.length) throw new Error('the image has no printable pixels; use a dark logo on a white or transparent background, or invert it')
  return inkRegions(union(spans))
}

/** Outline the bundled font once, in prepare, and keep the polygons in the op. */
export async function textRegions(text: string): Promise<P[][][]> {
  const R = await import('replicad')
  let font = R.getFont('regular')
  if (!font) {
    const { default: url } = await import('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff?url')
    const response = await fetch(url)
    if (!response.ok) throw new Error('could not load the PCB lettering font; retry when the bundled font is available')
    font = await R.loadFont(await response.arrayBuffer(), 'regular')
  }
  if ([...text].some((c) => !font.charToGlyph(c).index && !/\s/.test(c))) throw new Error('the PCB font does not contain one of these characters; use Latin letters, numbers and punctuation')
  const path = font.getPath(text, 0, 0, 100)
  const bounds = path.getBoundingBox()
  const width = bounds.x2 - bounds.x1
  if (!width) throw new Error('enter at least one visible character')
  const rings: P[][] = []
  let ring: P[] = [], current: P = { x: 0, y: 0 }
  const finish = () => { if (ring.length >= 3) rings.push(ring); ring = [] }
  const point = (x: number, y: number) => ({ x: (x - (bounds.x1 + bounds.x2) / 2) / width, y: ((bounds.y1 + bounds.y2) / 2 - y) / width })
  for (const c of path.commands) {
    if (c.type === 'M') {
      finish()
      ring = [point(c.x, c.y)]
      current = { x: c.x, y: c.y }
    } else if (c.type === 'L') {
      ring.push(point(c.x, c.y))
      current = { x: c.x, y: c.y }
    } else if (c.type === 'Q' || c.type === 'C') {
      const from = current
      for (let i = 1; i <= 12; i++) {
        const t = i / 12, u = 1 - t
        const x = c.type === 'Q' ? u * u * from.x + 2 * u * t * c.x1 + t * t * c.x : u ** 3 * from.x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x
        const y = c.type === 'Q' ? u * u * from.y + 2 * u * t * c.y1 + t * t * c.y : u ** 3 * from.y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y
        ring.push(point(x, y))
      }
      current = { x: c.x, y: c.y }
    } else if (c.type === 'Z') finish()
  }
  // Some OpenType font paths close implicitly on the next M/end, with no Z.
  finish()
  return inkRegions(fromPaths(Clipper.Union(toPaths(rings), undefined, FillRule.EvenOdd)))
}
