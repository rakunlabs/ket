// What a proposal changes compared to main, in a few readable lines.

import type { Doc } from './doc'

export interface Change {
  kind: 'added' | 'removed' | 'changed'
  what: string
  detail?: string
}

function byName<T>(list: T[] | undefined, key: (t: T) => string) {
  return new Map((list ?? []).map((x) => [key(x), x]))
}

function compare<T>(kind: string, a: T[] | undefined, b: T[] | undefined, key: (t: T) => string, show?: (t: T) => string): Change[] {
  const A = byName(a, key)
  const B = byName(b, key)
  const out: Change[] = []
  for (const [k, v] of B) {
    const old = A.get(k)
    if (!old) out.push({ kind: 'added', what: `${kind} ${k}`, detail: show?.(v) })
    else if (JSON.stringify(old) !== JSON.stringify(v)) out.push({ kind: 'changed', what: `${kind} ${k}`, detail: show ? `${show(old)} → ${show(v)}` : undefined })
  }
  for (const k of A.keys()) if (!B.has(k)) out.push({ kind: 'removed', what: `${kind} ${k}` })
  return out
}

export function diffDocs(main: Doc, next: Doc): Change[] {
  const out: Change[] = []
  out.push(...compare('parameter', main.parameters, next.parameters, (p) => p.name, (p) => String(p.expr)))
  out.push(...compare('sketch', main.sketches, next.sketches, (s) => s.name))
  out.push(...compare('feature', main.features, next.features, (f) => f.name, (f) => f.type))
  out.push(...compare('check', main.checks, next.checks, (c) => c.name))
  const mp = main.pcb
  const np = next.pcb
  if (!mp && np) out.push({ kind: 'added', what: 'board' })
  if (mp && !np) out.push({ kind: 'removed', what: 'board' })
  if (np) {
    if (mp && JSON.stringify([mp.outline, mp.thickness, mp.layers, mp.placement]) !== JSON.stringify([np.outline, np.thickness, np.layers, np.placement]))
      out.push({ kind: 'changed', what: 'board outline' })
    out.push(
      ...compare(
        'part',
        mp?.components,
        np.components,
        (c) => c.ref,
        (c) => `${c.mpn ?? c.lcsc} @ [${c.at.join(', ')}]`,
      ),
    )
    out.push(...compare('net', mp?.nets, np.nets, (n) => n.name, (n) => `${n.pins.length} pins`))
    const tr = (np.tracks.length ?? 0) - (mp?.tracks.length ?? 0)
    const vi = (np.vias.length ?? 0) - (mp?.vias.length ?? 0)
    if (tr || vi || JSON.stringify(mp?.tracks) !== JSON.stringify(np.tracks))
      out.push({ kind: 'changed', what: 'routing', detail: `${np.tracks.length} tracks (${tr >= 0 ? '+' : ''}${tr}), ${np.vias.length} vias (${vi >= 0 ? '+' : ''}${vi})` })
    out.push(...compare('pour', mp?.zones?.map((z, i) => ({ ...z, i })), np.zones?.map((z, i) => ({ ...z, i })), (z) => `${z.net}/${z.layer}`))
  }
  return out
}
