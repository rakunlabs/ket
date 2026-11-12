import { z } from 'zod'

import type { Doc } from '../doc'
import { define } from '../registry'

const point = z.tuple([z.number().finite(), z.number().finite()])
const number = z.number().int().min(1)

define({
  name: 'get_copper', group: 'pcb', kind: 'query',
  description: 'Read exact editable tracks and vias with their current 1-based numbers (the same object names used by get_problems). Filter by net/numbers and page results. Numbers are positions in the current revision, not permanent IDs: re-read after deleting/rerouting. Use edit_copper for small repairs, preview_changes before applying, then run_drc.',
  args: z.object({ nets: z.array(z.string()).optional(), tracks: z.array(number).optional(), vias: z.array(number).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(60) }),
  run(ctx, a) {
    const pcb = ctx.doc.pcb
    if (!pcb) throw new Error('the project has no board yet; start with set_board')
    const tracks = pcb.tracks.map((track, i) => ({ kind: 'track' as const, number: i + 1, ...track })).filter((t) => (!a.nets || a.nets.includes(t.net)) && (!a.tracks || a.tracks.includes(t.number)) && (!a.vias || a.tracks !== undefined))
    const vias = pcb.vias.map((via, i) => ({ kind: 'via' as const, number: i + 1, ...via })).filter((v) => (!a.nets || a.nets.includes(v.net)) && (!a.vias || a.vias.includes(v.number)) && (!a.tracks || a.vias !== undefined))
    const objects = [...tracks, ...vias]
    return { revision: ctx.revision, total: objects.length, objects: objects.slice(a.offset, a.offset + a.limit), truncated: a.offset + a.limit < objects.length }
  },
})

define({
  name: 'edit_copper', group: 'pcb', kind: 'mutate',
  description: 'Precisely repair existing copper without rerouting whole nets: move/resize track segments or vias and/or remove numbered objects. Numbers are 1-based from the current get_copper/get_problems revision; all edits/removals reference the original arrays and are atomic. Net identity stays unchanged. Refuses conflicting/unknown numbers. Use preview_changes first and run_drc afterwards; this command does not certify legality or silently weaken rules.',
  args: z.object({
    tracks: z.array(z.object({ number, width: z.number().positive().max(100).optional(), points: z.array(point).min(2).max(10000).optional(), layer: z.enum(['F.Cu', 'B.Cu', 'In1.Cu', 'In2.Cu']).optional() })).max(200).default([]),
    vias: z.array(z.object({ number, at: point.optional(), diameter: z.number().positive().max(100).optional(), drill: z.number().positive().max(100).optional() })).max(200).default([]),
    remove_tracks: z.array(number).max(10000).default([]), remove_vias: z.array(number).max(10000).default([]),
  }),
  apply(doc, a) {
    if (!doc.pcb) throw new Error('the project has no board yet; start with set_board')
    if (!a.tracks.length && !a.vias.length && !a.remove_tracks.length && !a.remove_vias.length) throw new Error('no copper edits supplied; use get_copper and specify tracks/vias or removals')
    const next = JSON.parse(JSON.stringify(doc)) as Doc, pcb = next.pcb!
    for (const [kind, changes, removals, items] of [['track', a.tracks, a.remove_tracks, pcb.tracks], ['via', a.vias, a.remove_vias, pcb.vias]] as const) {
      const all = [...changes.map((c) => c.number), ...removals]
      if (new Set(all).size !== all.length) throw new Error(`${kind} numbers are duplicated or both edited and removed; specify each original number once`)
      for (const n of all) if (!items[n - 1]) throw new Error(`no ${kind} ${n}; re-read get_copper for the current revision`)
    }
    for (const { number, ...edit } of a.tracks) {
      if (!Object.keys(edit).length) throw new Error(`track ${number}: specify width, points or layer`)
      if (pcb.layers === 2 && edit.layer?.startsWith('In')) throw new Error(`track ${number}: ${edit.layer} is unavailable on a 2-layer board; use F.Cu/B.Cu or set_board layers: 4`)
      Object.assign(pcb.tracks[number - 1], edit)
    }
    for (const { number, ...edit } of a.vias) {
      if (!Object.keys(edit).length) throw new Error(`via ${number}: specify at, diameter or drill`)
      Object.assign(pcb.vias[number - 1], edit)
      if (pcb.vias[number - 1].drill >= pcb.vias[number - 1].diameter) throw new Error(`via ${number}: drill must be smaller than copper diameter`)
    }
    pcb.tracks = pcb.tracks.filter((_, i) => !a.remove_tracks.includes(i + 1))
    pcb.vias = pcb.vias.filter((_, i) => !a.remove_vias.includes(i + 1))
    return { doc: next, summary: `edited ${a.tracks.length} tracks and ${a.vias.length} vias; removed ${a.remove_tracks.length} tracks and ${a.remove_vias.length} vias` }
  },
})
