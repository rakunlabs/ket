// Reusable blocks: a .ket project put into the current design under a
// prefix, so the same block can go in more than once. The block's ops are
// replayed on their own; the resulting document is renamed (parameters,
// sketches, features, checks, materials, decals, part refs, nets) and merged.
// Renaming the result, not the commands, keeps every reference consistent,
// whatever commands made it.

import { z } from 'zod'

import { type Doc, type Feature, inputsOf } from './doc'
import { namesIn } from './expr'
import { readProjectFile, PROJECT_FILE_LIMIT } from './project-file'
import { define } from './registry'

const ident = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Replaces whole-word names in an expression string. */
function renameExpr(e: unknown, map: Map<string, string>): unknown {
  if (typeof e !== 'string') return e
  let used: string[]
  try {
    used = namesIn(e)
  } catch {
    return e
  }
  if (!used.some((n) => map.has(n))) return e
  // Names only: not a member after a dot (board.h) and not a function call (max(...)).
  return e.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (w, at: number) => {
    if (at > 0 && /[.\w]/.test(e[at - 1])) return w
    if (/^\s*\(/.test(e.slice(at + w.length))) return w
    return map.get(w) ?? w
  })
}

/**
 * Keys whose string values are never expressions: enum values, ids and names
 * of other objects, free text. deepExpr leaves them alone (references are
 * renamed on their own, below).
 */
const NOT_EXPR = new Set([
  'name', 'type', 'kind', 'op', 'plane', 'axis', 'side', 'anchor', 'align', 'valign', 'mode', 'preset', 'face', 'faces', 'edges', 'selector', 'select',
  'id', 'a', 'b', 'line', 'point', 'on', 'of', 'about', 'center', 'start', 'end', 'with', 'body', 'target', 'source', 'hook', 'drive', 'tools', 'sketch', 'material', 'inner', 'outer',
  'text', 'note', 'description', 'url', 'image', 'font', 'color', 'background', 'ref', 'net', 'layer', 'lcsc', 'mpn', 'package', 'footprint', 'pins', 'pin_names', 'model',
])

/** Walks a JSON value, renaming parameter names in the strings that are expressions. */
function deepExpr(v: unknown, map: Map<string, string>, key = ''): unknown {
  if (typeof v === 'string') return NOT_EXPR.has(key) ? v : renameExpr(v, map)
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' && NOT_EXPR.has(key) ? x : deepExpr(x, map, key)))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, NOT_EXPR.has(k) && (typeof x === 'string' || (Array.isArray(x) && x.every((y) => typeof y === 'string'))) ? x : deepExpr(x, map, k)]))
  return v
}

/** Adds a constant to an expression, keeping numbers numbers. */
const plus = (e: unknown, d: number) => (!d ? e : typeof e === 'number' ? e + d : `(${e}) + ${d}`)

/** Feature fields that hold the name of another feature. */
const FEATURE_REFS = ['target', 'source', 'of', 'hook', 'drive'] as const

export interface BlockResult {
  doc: Doc
  added: Record<string, number>
  /** Parts of the block that are not taken (board-wide or design-wide). */
  skipped: string[]
}

/**
 * Merges block into doc under prefix (refs get it as letters: J1 → PWRJ1),
 * moved by offset in the 3D model and on the board. Fails on any name that
 * would clash, naming it.
 */
export function insertBlock(doc: Doc, block: Doc, prefix: string, offset: [number, number, number] = [0, 0, 0]): BlockResult {
  const p = (n: string) => `${prefix}_${n}`
  const params = new Map(block.parameters.map((x) => [x.name, p(x.name)]))
  const feats = new Map(block.features.map((f) => [f.name, p(f.name)]))
  const sketches = new Map(block.sketches.map((s) => [s.name, p(s.name)]))
  const materials = new Map((block.materials ?? []).map((m) => [m.name, p(m.name)]))
  const refPrefix = prefix.toUpperCase().replace(/[^A-Z]/g, '')
  if (!refPrefix && block.pcb?.components.length) throw new Error('prefix needs letters: part refs get them in front (J1 → PWRJ1)')
  const refs = new Map((block.pcb?.components ?? []).map((c) => [c.ref, `${refPrefix}${c.ref}`]))
  // Nets keep global names (GND, 3V3 join the design's), others get the prefix.
  const GLOBAL = /^(GND|AGND|DGND|PGND|VCC|VDD|VIN|VBUS|VSYS|[0-9]+V[0-9]*|V[0-9]+V[0-9]*|\+[0-9].*)$/i
  const nets = new Map((block.pcb?.nets ?? []).map((n) => [n.name, GLOBAL.test(n.name) ? n.name : p(n.name)]))
  // A feature name, or a part's body (part_J1 → part_PWRJ1).
  const body = (n: string) => feats.get(n) ?? (n.startsWith('part_') && refs.has(n.slice(5)) ? `part_${refs.get(n.slice(5))}` : n)
  const clash = (kind: string, mine: Iterable<string>, theirs: Iterable<string>) => {
    const have = new Set(theirs)
    const dup = [...mine].filter((n) => have.has(n))
    if (dup.length) throw new Error(`${kind} ${dup.slice(0, 5).join(', ')} already exist${dup.length === 1 ? 's' : ''}; choose another prefix`)
  }
  clash('parameter', params.values(), doc.parameters.map((x) => x.name))
  clash('feature', feats.values(), doc.features.map((x) => x.name))
  clash('sketch', sketches.values(), doc.sketches.map((x) => x.name))
  clash('material', materials.values(), (doc.materials ?? []).map((x) => x.name))
  clash('part', refs.values(), (doc.pcb?.components ?? []).map((c) => c.ref))
  for (const v of [...params.values(), ...feats.values(), ...sketches.values()]) if (!ident.test(v)) throw new Error(`"${v}" is not a valid name; use a prefix of letters, digits and _`)

  const next = structuredClone(doc)
  const pin = (s: string) => {
    const i = s.indexOf('.')
    return i < 0 ? s : `${refs.get(s.slice(0, i)) ?? s.slice(0, i)}${s.slice(i)}`
  }

  next.parameters.push(...block.parameters.map((x) => ({ ...x, name: params.get(x.name)!, expr: renameExpr(x.expr, params) as never })))
  next.sketches.push(
    ...block.sketches.map((s) => ({
      ...(deepExpr(s, params) as typeof s),
      name: sketches.get(s.name)!,
      ...(s.on ? { on: { ...s.on, feature: feats.get(s.on.feature) ?? s.on.feature } } : {}),
    })),
  )
  const [dx, dy, dz] = offset
  const moved = new Set<string>()
  for (const f of block.features) {
    const g = deepExpr(f, params) as Record<string, unknown>
    g.name = feats.get(f.name)
    for (const k of FEATURE_REFS) if (typeof g[k] === 'string') g[k] = body(g[k] as string)
    if (Array.isArray(g.tools)) g.tools = (g.tools as string[]).map(body)
    for (const k of ['mesh', 'coaxial'] as const) {
      const m = g[k] as { with?: string } | undefined
      if (m?.with) g[k] = { ...m, with: feats.get(m.with) ?? m.with }
    }
    if (typeof g.sketch === 'string') g.sketch = sketches.get(g.sketch) ?? g.sketch
    if (Array.isArray(g.sections)) g.sections = (g.sections as { sketch?: string }[]).map((s) => (s.sketch ? { ...s, sketch: sketches.get(s.sketch) ?? s.sketch } : s))
    if (typeof g.material === 'string') g.material = materials.get(g.material) ?? g.material
    if (Array.isArray(g.pulleys)) g.pulleys = (g.pulleys as { body?: string }[]).map((x) => (x.body ? { ...x, body: feats.get(x.body) ?? x.body } : x))
    next.features.push(g as unknown as Feature)
  }
  // Move the block's final bodies by the offset: each is built as before under
  // name_at, and a transform under its own name moves it. Checks and decals
  // name final bodies, so they follow the moved ones.
  if (dx || dy || dz) {
    const consumed = new Set(block.features.flatMap((f) => inputsOf(f)))
    const mine = new Set(block.features.map((f) => feats.get(f.name)!))
    for (const f of block.features) {
      if (consumed.has(f.name) || f.hidden) continue
      const name = feats.get(f.name)!
      const inner = `${name}_at`
      if (next.features.some((x) => x.name === inner)) throw new Error(`feature ${inner} already exists; choose another prefix`)
      const i = next.features.findIndex((x) => x.name === name)
      next.features[i] = { ...next.features[i], name: inner } as Feature
      // Sketches on its faces and instances of it now point at the unmoved body: keep them on the moved one.
      for (const s of next.sketches) if (s.on?.feature === name) s.on = { ...s.on, feature: inner }
      // The block's own references (gear meshes, instances, drives) mean the body as the block
      // built it: they move with it through their own transform, so they point at the unmoved one.
      for (const [j, x] of next.features.entries()) {
        if (!mine.has(x.name) && !mine.has(x.name.replace(/_at$/, ''))) continue
        const g = { ...x } as Record<string, unknown>
        for (const k of FEATURE_REFS) if (g[k] === name) g[k] = inner
        for (const k of ['mesh', 'coaxial']) {
          const m = g[k] as { with?: string } | undefined
          if (m?.with === name) g[k] = { ...m, with: inner }
        }
        if (Array.isArray(g.pulleys)) g.pulleys = (g.pulleys as { body?: string }[]).map((q) => (q.body === name ? { ...q, body: inner } : q))
        next.features[j] = g as unknown as Feature
      }
      next.features.push({ name, type: 'transform', target: inner, translate: [dx, dy, dz] } as Feature)
      moved.add(name)
    }
  }
  next.checks.push(...block.checks.map((c) => {
    const g = deepExpr(c, params) as Record<string, unknown>
    g.name = p(c.name)
    for (const k of ['a', 'b', 'inner', 'outer', 'target']) if (typeof g[k] === 'string') g[k] = body(g[k] as string)
    for (const k of ['bodies', 'targets']) if (Array.isArray(g[k])) g[k] = (g[k] as string[]).map(body)
    return g as unknown as (typeof next.checks)[number]
  }))
  if (block.materials?.length) next.materials = [...(next.materials ?? []), ...block.materials.map((m) => ({ ...m, name: materials.get(m.name)! }))]
  if (block.decals?.length)
    next.decals = [
      ...(next.decals ?? []),
      ...block.decals.map((d) => {
        const g = deepExpr(d, params) as typeof d
        // A decal sits at a world point: it moves with its body.
        const at = moved.has(feats.get(d.target) ?? '') ? ([plus(g.at[0], dx), plus(g.at[1], dy), plus(g.at[2], dz)] as typeof g.at) : g.at
        return { ...g, at, name: p(d.name), target: body(d.target) }
      }),
    ]

  if (block.pcb) {
    if (!next.pcb) throw new Error('the block has a board part; set_board first so its parts have a board to go on')
    if (block.pcb.layers > next.pcb.layers) throw new Error(`the block uses ${block.pcb.layers} copper layers and the board has ${next.pcb.layers}`)
    const bx = dx
    const by = dy
    for (const c of block.pcb.components) {
      // value is the part's printed value ("10k"), not an expression.
      const g = { ...(deepExpr(c, params) as typeof c), ...(c.value !== undefined ? { value: c.value } : {}) }
      next.pcb.components.push({ ...g, ref: refs.get(c.ref)!, at: [plus(g.at[0], bx), plus(g.at[1], by)] as never, footprint: c.footprint })
    }
    for (const n of block.pcb.nets) {
      const name = nets.get(n.name)!
      const pins = n.pins.map(pin)
      const into = next.pcb.nets.find((x) => x.name === name)
      // Only power and ground join the design's nets; a prefixed name that is taken is a clash.
      if (into && name !== n.name) throw new Error(`net ${name} already exists; choose another prefix`)
      if (into) into.pins.push(...pins)
      else next.pcb.nets.push({ ...n, name, pins })
    }
    const netName = (n: string) => nets.get(n) ?? n
    if (block.pcb.diff_pairs?.length) next.pcb.diff_pairs = [...(next.pcb.diff_pairs ?? []), ...block.pcb.diff_pairs.map((d) => ({ ...d, name: p(d.name), p: netName(d.p), n: netName(d.n) }))]
    if (block.pcb.length_groups?.length) next.pcb.length_groups = [...(next.pcb.length_groups ?? []), ...block.pcb.length_groups.map((g) => ({ ...g, name: p(g.name), nets: g.nets.map(netName) }))]
    // Pair classes follow their pair's new name; other classes are shared by name (the design's wins).
    const pairClass = new Map((block.pcb.diff_pairs ?? []).map((d) => [`pair_${d.name}`, `pair_${p(d.name)}`]))
    for (const n of next.pcb.nets) if (n.class && pairClass.has(n.class) && n.pins.some((x) => [...refs.values()].includes(x.slice(0, x.indexOf('.'))))) n.class = pairClass.get(n.class)
    for (const c of block.pcb.classes) {
      const name = pairClass.get(c.name) ?? c.name
      if (!next.pcb.classes.some((x) => x.name === name)) next.pcb.classes.push({ ...c, name })
    }
    next.pcb.tracks.push(...block.pcb.tracks.map((t) => ({ ...t, net: nets.get(t.net) ?? t.net, points: t.points.map(([x, y]) => [x + bx, y + by] as [number, number]) })))
    next.pcb.vias.push(...block.pcb.vias.map((v) => ({ ...v, net: nets.get(v.net) ?? v.net, at: [v.at[0] + bx, v.at[1] + by] as [number, number] })))
    if (block.pcb.wires?.length) next.pcb.wires = [...(next.pcb.wires ?? []), ...block.pcb.wires.map((w) => ({ ...w, a: pin(w.a), b: pin(w.b) }))]
  }
  const skipped = [
    block.motion && 'motion',
    block.configurations?.length && 'configurations',
    block.explode && 'explode',
    block.pcb?.keepouts?.length && 'keep-outs',
    block.pcb?.zones?.length && 'pours',
    block.pcb?.artwork?.length && 'board artwork',
  ].filter(Boolean) as string[]
  return {
    doc: next,
    skipped,
    added: { parameters: params.size, sketches: sketches.size, features: feats.size + moved.size, checks: block.checks.length, parts: refs.size, nets: [...nets.values()].filter((n, i, a) => a.indexOf(n) === i).length },
  }
}

define({
  name: 'insert_block',
  group: 'project',
  kind: 'mutate',
  description:
    'Put a reusable block (the text of a .ket project file, e.g. a USB-C power input, a mounting boss pattern, a battery holder) into this design under a prefix, so it can go in more than once: its parameters, sketches, features, checks and materials get prefix_ in front, its part refs the prefix letters (J1 → PWRJ1), its nets prefix_ unless they are power or ground (GND, 3V3, VBUS join the design\'s nets). offset moves its bodies and board parts. Board-wide items of the block (outline, pours, keep-outs) are not taken. Fails on a name clash, naming it.',
  args: z.object({
    data: z.string().max(PROJECT_FILE_LIMIT).describe('The block: the whole text of a .ket project file. Over MCP, give block: <name> of a server block instead (list_templates)'),
    prefix: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,15}$/, 'a prefix of letters, digits and _, starting with a letter'),
    offset: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Move the block by [x, y, z] mm (board parts by x, y)'),
  }),
  apply(doc, a) {
    const block = readProjectFile(a.data).doc
    const r = insertBlock(doc, block, a.prefix, a.offset)
    const what = Object.entries(r.added).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')
    return { doc: r.doc, summary: `inserted block ${a.prefix}: ${what || 'nothing'}${r.skipped.length ? `; not taken: ${r.skipped.join(', ')}` : ''}` }
  },
})
