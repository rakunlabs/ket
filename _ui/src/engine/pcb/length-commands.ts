// Differential pairs, length groups and the length report.

import { z } from 'zod'

import { define } from '../registry'
import { ident } from '../schema'
import { DEFAULT_CLASS } from './board'
import type { Track } from '../doc'
import { netLengths, pairReports } from './lengths'
import { tuneLength } from './tune'
import { clone, pcbOf } from './shared'

define({
  name: 'set_diff_pair',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Declare a differential pair: two nets (p, n) routed side by side at width and gap, e.g. USB D+/D− at 90 Ω (impedance gives width and gap for the stackup). Both nets get a net class with that width. run_drc then checks the gap where they run together, how much of their length is coupled, their widths and the skew (length difference, default within 0.15 mm); get_net_lengths reports them. autoroute routes declared pairs first, together at the gap, and evens their lengths with a meander; when they do not fit side by side it routes them apart and says so.',
  args: z.object({
    name: ident,
    p: z.string(),
    n: z.string(),
    width: z.number().positive(),
    gap: z.number().positive(),
    skew: z.number().min(0).optional().describe('Allowed length difference, mm (default 0.15)'),
    impedance: z.number().positive().optional().describe('Target differential impedance, Ω (for the report)'),
  }),
  examples: [{ name: 'usb', p: 'USB_DP', n: 'USB_DN', width: 0.2, gap: 0.15, impedance: 90 }],
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    for (const net of [a.p, a.n]) if (!pcb.nets.some((x) => x.name === net)) throw new Error(`no net "${net}"; connect it first`)
    if (a.p === a.n) throw new Error('p and n must be two different nets')
    const other = (pcb.diff_pairs ?? []).find((d) => d.name !== a.name && [d.p, d.n].some((x) => x === a.p || x === a.n))
    if (other) throw new Error(`${[a.p, a.n].find((x) => x === other.p || x === other.n)} is already in pair ${other.name}`)
    const pair = { name: a.name, p: a.p, n: a.n, width: a.width, gap: a.gap, ...(a.skew !== undefined ? { skew: a.skew } : {}), ...(a.impedance ? { impedance: a.impedance } : {}) }
    pcb.diff_pairs = [...(pcb.diff_pairs ?? []).filter((d) => d.name !== a.name), pair]
    // The pair's class: its width, and the gap as clearance, since the two run that close to each other.
    // (The JLCPCB minimum, 0.127 mm, still applies: DRC checks it.)
    const cls = `pair_${a.name}`
    const old = pcb.classes.find((c) => c.name === cls) ?? { ...DEFAULT_CLASS, name: cls }
    pcb.classes = [...pcb.classes.filter((c) => c.name !== cls), { ...old, track: a.width, clearance: Math.min(a.gap, DEFAULT_CLASS.clearance) }]
    if (a.gap < 0.127) throw new Error(`gap ${a.gap} mm is below JLCPCB's 0.127 mm minimum spacing`)
    for (const net of pcb.nets) if (net.name === a.p || net.name === a.n) net.class = cls
    return { doc: next, summary: `pair ${a.name}: ${a.p}/${a.n} at ${a.width} mm, gap ${a.gap} mm` }
  },
})

define({
  name: 'set_length_group',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Nets whose routed lengths must match within a tolerance (a parallel bus, the lanes of an interface), optionally with min/max for every net. Lengths are track length plus the via barrels. run_drc reports nets outside it; get_net_lengths shows them.',
  args: z.object({
    name: ident,
    nets: z.array(z.string()).min(2),
    tolerance: z.number().min(0),
    min: z.number().min(0).optional(),
    max: z.number().positive().optional(),
  }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const missing = a.nets.filter((x) => !pcb.nets.some((n) => n.name === x))
    if (missing.length) throw new Error(`no net ${missing.join(', ')}`)
    pcb.length_groups = [...(pcb.length_groups ?? []).filter((g) => g.name !== a.name), { name: a.name, nets: a.nets, tolerance: a.tolerance, ...(a.min !== undefined ? { min: a.min } : {}), ...(a.max !== undefined ? { max: a.max } : {}) }]
    return { doc: next, summary: `length group ${a.name}: ${a.nets.length} nets within ${a.tolerance} mm` }
  },
})

define({
  name: 'remove_length_rules',
  group: 'pcb',
  kind: 'mutate',
  description: 'Remove differential pairs and/or length groups by name (the pair\'s net class stays).',
  args: z.object({ names: z.array(z.string()).min(1) }),
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const known = [...(pcb.diff_pairs ?? []).map((d) => d.name), ...(pcb.length_groups ?? []).map((g) => g.name)]
    const missing = a.names.filter((x) => !known.includes(x))
    if (missing.length) throw new Error(`no pair or group ${missing.join(', ')}; there are: ${known.join(', ') || '(none)'}`)
    pcb.diff_pairs = (pcb.diff_pairs ?? []).filter((d) => !a.names.includes(d.name))
    pcb.length_groups = (pcb.length_groups ?? []).filter((g) => !a.names.includes(g.name))
    if (!pcb.diff_pairs.length) delete pcb.diff_pairs
    if (!pcb.length_groups.length) delete pcb.length_groups
    return { doc: next, summary: `removed ${a.names.join(', ')}` }
  },
})

define({
  name: 'get_net_lengths',
  group: 'pcb',
  kind: 'query',
  description: 'Routed length of nets (track length plus via barrels through the stackup), with the differential pairs (each net, skew, the gap where they run together and how much is coupled) and length groups (spread from the longest). Default: every net in a pair or group, else every net.',
  args: z.object({ nets: z.array(z.string()).optional() }),
  async run(ctx, a) {
    const st = await ctx.kernel.board()
    if (!st || !ctx.doc.pcb) throw new Error('the project has no board yet; start with set_board')
    const pcb = ctx.doc.pcb
    const ruled = [...new Set([...(pcb.diff_pairs ?? []).flatMap((d) => [d.p, d.n]), ...(pcb.length_groups ?? []).flatMap((g) => g.nets)])]
    const nets = a.nets ?? (ruled.length ? ruled : pcb.nets.map((n) => n.name))
    const lengths = netLengths(pcb, st.board, nets)
    const by = new Map(lengths.map((l) => [l.net, l]))
    const all = new Map(netLengths(pcb, st.board).map((l) => [l.net, l]))
    return {
      nets: lengths,
      pairs: pairReports(pcb, st.board).map((r) => ({ ...r, p: r.p.length, n: r.n.length, allowed_skew: pcb.diff_pairs!.find((d) => d.name === r.name)!.skew ?? 0.15, gap_target: pcb.diff_pairs!.find((d) => d.name === r.name)!.gap })),
      groups: (pcb.length_groups ?? []).map((g) => {
        const ls = g.nets.map((n) => by.get(n) ?? all.get(n)!).filter(Boolean)
        const longest = Math.max(...ls.map((l) => l.length))
        return { name: g.name, tolerance: g.tolerance, longest, spread: Math.round((longest - Math.min(...ls.map((l) => l.length))) * 1000) / 1000, nets: ls.map((l) => ({ net: l.net, length: l.length, short_by: Math.round((longest - l.length) * 1000) / 1000 })) }
      }),
    }
  },
})

define({
  name: 'tune_length',
  group: 'pcb',
  kind: 'mutate',
  description:
    'Lengthen a routed net to a target with a serpentine (meander) in its longest straight run that has room and keeps clearance: for matching a pair\'s skew or a bus. Give target (mm), or match: another net (its length) or a pair/group name (its longest). amplitude is the bump height (default 3 × width), spacing the leg pitch (default 3 × width). Check with get_net_lengths and run_drc; the meander may need a free strip beside the track (side: 1 left, -1 right, 0 both).',
  args: z.object({
    net: z.string(),
    target: z.number().positive().optional(),
    match: z.string().optional().describe('A net, or a pair/length group name: tune to its (longest) length'),
    amplitude: z.number().positive().optional(),
    spacing: z.number().positive().optional(),
    side: z.union([z.literal(1), z.literal(-1), z.literal(0)]).optional(),
    tracks: z.array(z.record(z.string(), z.unknown())).optional().describe('(filled in automatically)'),
    report: z.record(z.string(), z.unknown()).optional().describe('(filled in automatically)'),
  }),
  internal: ['tracks', 'report'],
  async prepare(ctx, a) {
    const st = await ctx.kernel.board()
    if (!st || !ctx.doc.pcb) throw new Error('the project has no board yet; start with set_board')
    const pcb = ctx.doc.pcb
    let target = a.target
    if (a.match) {
      const pair = pcb.diff_pairs?.find((d) => d.name === a.match)
      const group = pcb.length_groups?.find((g) => g.name === a.match)
      const nets = pair ? [pair.p, pair.n] : group ? group.nets : [a.match]
      if (!pair && !group && !pcb.nets.some((n) => n.name === a.match)) throw new Error(`match: no net, pair or group "${a.match}"`)
      target = Math.max(...netLengths(pcb, st.board, nets).map((l) => l.length))
    }
    if (!target) throw new Error('give target (mm) or match (a net, pair or group)')
    const w = Math.max(...pcb.tracks.filter((x) => x.net === a.net).map((x) => x.width), 0.1)
    const r = tuneLength(pcb, st.board, a.net, target, { amplitude: a.amplitude ?? 3 * w, spacing: a.spacing ?? 3 * w, side: a.side })
    // The meander goes into the op, so replay never re-plans it.
    return { ...a, target, tracks: r.tracks.filter((t) => t.net === a.net) as never, report: { before: r.before, after: r.after, added: r.added, ...(r.note ? { note: r.note } : {}) } }
  },
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    const tracks = a.tracks as unknown as Track[] | undefined
    if (!tracks) throw new Error('tune_length was not prepared; run it through the session')
    pcb.tracks = [...pcb.tracks.filter((t) => t.net !== a.net), ...tracks]
    const r = a.report as { before: number; after: number; note?: string }
    return { doc: next, summary: `tuned ${a.net}: ${r.before.toFixed(3)} → ${r.after.toFixed(3)} mm${r.note ? ` (${r.note})` : ''}` }
  },
})
