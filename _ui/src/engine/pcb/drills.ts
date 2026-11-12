// One source of drilling geometry for DRC, previews, CAD and fabrication.
import type { P, Pcb } from '../doc'
import type { ResolvedBoard } from './board'

export interface BoardDrill {
  id: string
  at: P
  d: number
  plated: boolean
  /** Tool-center travel; equal ends describe a round drilled hole. */
  from: P
  to: P
}

export function boardDrills(pcb: Pcb, board: ResolvedBoard): BoardDrill[] {
  return [
    ...board.holes.map((h, i) => ({ id: h.ref ? `${h.ref}.hole${i + 1}` : `hole ${i + 1}`, at: h.at, d: h.d, plated: false, from: h.at, to: h.at })),
    ...board.pads.filter((p) => p.drill).map((p) => ({ id: `${p.ref}.${p.pin}`, at: p.center, d: p.drill!, plated: p.drillPlated !== false, from: p.drillSlot?.[0] ?? p.center, to: p.drillSlot?.[1] ?? p.center })),
    ...pcb.vias.map((v, i) => { const at = { x: v.at[0], y: v.at[1] }; return { id: `via ${i + 1}`, at, d: v.drill, plated: true, from: at, to: at } }),
  ]
}

/** Inscribed tessellation, used only for drawing; DRC uses the exact segment/radius. */
export function drillRing(drill: Pick<BoardDrill, 'from' | 'to' | 'd'>, steps = 24): P[] {
  const angle = Math.atan2(drill.to.y - drill.from.y, drill.to.x - drill.from.x)
  const out: P[] = [], r = drill.d / 2
  for (const [center, start] of [[drill.to, angle - Math.PI / 2], [drill.from, angle + Math.PI / 2]] as const) {
    for (let i = 0; i <= steps; i++) {
      const a = start + i / steps * Math.PI
      out.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) })
    }
  }
  return out
}
