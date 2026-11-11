// Exploded view offsets (display only): which steps of doc.explode move a
// body, summed. Board parts without a step of their own move with "board".

import type { Doc } from './doc'
import { num } from './expr'

const hit = (pat: string, n: string) => (pat.endsWith('*') ? n.startsWith(pat.slice(0, -1)) : pat === n)

export function explodeOffset(doc: Doc, params: Map<string, number>, name: string): [number, number, number] | undefined {
  const steps = doc.explode?.steps
  if (!steps?.length) return undefined
  const own = steps.some((st) => st.names.some((p) => hit(p, name)))
  const t: [number, number, number] = [0, 0, 0]
  let any = false
  for (const st of steps) {
    const mine = st.names.some((p) => hit(p, name))
    const viaBoard = !own && name.startsWith('part_') && st.names.includes('board')
    if (!mine && !viaBoard) continue
    try {
      for (let i = 0; i < 3; i++) t[i] += num(st.offset[i], params, `explode offset[${i}]`)
      any = true
    } catch {
      // A bad expression only skips that step.
    }
  }
  return any ? t : undefined
}
