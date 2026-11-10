// The CAD commands. Each feature command adds a feature, or replaces the
// feature of the same name when replace is true, so a model can redefine a
// part without deleting and re-adding everything that depends on it.

import { z } from 'zod'

import { type Doc, type Feature, findFeature, inputsOf, normalizeDoc, sketchesOf } from './doc'
import { namesIn } from './expr'
import { define, applyOp } from './registry'
import { checkDef, common, expr, featureName, featureRef, ident, placement, plane, profile, selector, vec2, vec3 } from './schema'

const replace = z
  .boolean()
  .optional()
  .describe('Replace the existing feature with this name, keeping its position in the list (default false: fail if the name exists)')

function clone(doc: Doc): Doc {
  // JSON, not structuredClone: the doc may be a Svelte state proxy, and it
  // is plain data by design.
  return normalizeDoc(JSON.parse(JSON.stringify(doc)) as Doc)
}

function upsert(doc: Doc, f: Feature, replaceIt: boolean | undefined): { doc: Doc; summary: string } {
  const next = clone(doc)
  for (const s of sketchesOf(f)) {
    if (!next.sketches.some((x) => x.name === s)) {
      throw new Error(`sketch "${s}" does not exist; sketches are: ${next.sketches.map((x) => x.name).join(', ') || '(none yet; create one with sketch)'}`)
    }
  }
  const i = next.features.findIndex((x) => x.name === f.name)
  if (i >= 0) {
    if (!replaceIt) {
      throw new Error(`a feature named "${f.name}" exists (${next.features[i].type}); pick another name, or pass replace: true to redefine it`)
    }
    next.features[i] = f
    return { doc: next, summary: `replaced ${f.type} ${f.name}` }
  }
  for (const input of inputsOf(f)) {
    if (!findFeature(next, input)) {
      const known = next.features.map((x) => x.name)
      throw new Error(`"${input}" does not exist; features are: ${known.join(', ') || '(none yet)'}`)
    }
  }
  next.features.push(f)
  return { doc: next, summary: `added ${f.type} ${f.name}` }
}

/** Removes undefined fields so the stored op and document stay compact. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

function featureCommand<S extends z.ZodRawShape>(
  name: string,
  type: Feature['type'],
  description: string,
  shape: S,
  examples: z.input<z.ZodObject<S & typeof common & { replace: typeof replace }>>[],
) {
  const args = z.object({ ...common, ...shape, replace })
  define({
    name,
    group: 'cad',
    kind: 'mutate',
    description,
    args,
    examples,
    apply(doc, a) {
      const { replace: r, ...rest } = a as Record<string, unknown> & { replace?: boolean }
      return upsert(doc, compact({ ...rest, type }) as unknown as Feature, r)
    },
  })
}

// ── Parameters ──────────────────────────────────────────────────────────

define({
  name: 'set_parameters',
  group: 'params',
  kind: 'mutate',
  description:
    'Create or update named parameters. Values are numbers (mm, degrees) or expressions over other parameters. Use parameters for every dimension that matters (board size, wall, clearance) so the design stays editable: change one and every feature that uses it rebuilds.',
  args: z.object({
    parameters: z
      .array(
        z.object({
          name: ident,
          expr: expr,
          unit: z.string().optional(),
          description: z.string().optional(),
        }),
      )
      .min(1),
  }),
  examples: [
    {
      parameters: [
        { name: 'board_w', expr: 50, description: 'PCB width' },
        { name: 'wall', expr: 2 },
        { name: 'case_w', expr: 'board_w + 2*wall + 1' },
      ],
    },
  ],
  apply(doc, a) {
    const next = clone(doc)
    const changed: string[] = []
    for (const p of a.parameters) {
      const entry = compact({ name: p.name, expr: p.expr, unit: p.unit, description: p.description })
      const i = next.parameters.findIndex((x) => x.name === p.name)
      if (i >= 0) next.parameters[i] = { ...next.parameters[i], ...entry }
      else next.parameters.push(entry)
      changed.push(`${p.name}=${p.expr}`)
    }
    return { doc: next, summary: `set ${changed.join(', ')}` }
  },
})

define({
  name: 'delete_parameters',
  group: 'params',
  kind: 'mutate',
  description: 'Delete parameters. Fails while a parameter, feature or check still uses one of them.',
  args: z.object({ names: z.array(z.string()).min(1) }),
  apply(doc, a) {
    const next = clone(doc)
    const drop = new Set(a.names)
    const users: string[] = []
    const scan = (owner: string, v: unknown) => {
      if (typeof v === 'string') {
        try {
          for (const n of namesIn(v)) if (drop.has(n)) users.push(`${owner} uses ${n}`)
        } catch {
          // not an expression
        }
      } else if (Array.isArray(v)) v.forEach((x) => scan(owner, x))
      else if (v && typeof v === 'object') for (const x of Object.values(v)) scan(owner, x)
    }
    for (const p of next.parameters) if (!drop.has(p.name)) scan(`parameter ${p.name}`, p.expr)
    for (const f of next.features) scan(`feature ${f.name}`, { ...f, name: undefined, target: undefined, tools: undefined })
    for (const c of next.checks) scan(`check ${c.name}`, c)
    if (users.length) throw new Error(`cannot delete: ${users.join('; ')}`)
    const missing = a.names.filter((n) => !next.parameters.some((p) => p.name === n))
    if (missing.length) throw new Error(`no parameter ${missing.join(', ')}`)
    next.parameters = next.parameters.filter((p) => !drop.has(p.name))
    return { doc: next, summary: `deleted parameters ${a.names.join(', ')}` }
  },
})

// ── Primitives ──────────────────────────────────────────────────────────

featureCommand(
  'box',
  'box',
  'Add a box. By default it is centered on X and Y and sits on Z=0 (from z=0 to z=size[2]). Set center to choose per axis: [true,true,false] is the default, true centers all axes, false puts the corner at the origin.',
  {
    size: vec3.describe('[x, y, z] size in mm'),
  center: z.union([z.boolean(), z.tuple([z.boolean(), z.boolean(), z.boolean()])]).optional(),
    ...placement,
  },
  [{ name: 'case_body', size: ['case_w', 'case_d', 'case_h'] }, { name: 'tab', size: [10, 5, 2], translate: [20, 0, 0] }],
)

featureCommand(
  'cylinder',
  'cylinder',
  'Add a cylinder. Its base circle is centered on the origin and it extends along +axis (default Z) by h.',
  { r: expr.describe('Radius'), h: expr.describe('Height'), axis: z.enum(['X', 'Y', 'Z']).optional(), ...placement },
  [{ name: 'standoff', r: 2.5, h: 'standoff_h', translate: [20, 15, 'wall'] }],
)

featureCommand('sphere', 'sphere', 'Add a sphere centered on the origin.', { r: expr, ...placement }, [{ name: 'knob', r: 5, translate: [0, 0, 20] }])

featureCommand(
  'extrude',
  'extrude',
  'Extrude a closed 2D outline into a solid. Either sketch (a constrained sketch, see the sketch command; holes inside the outline stay holes) or a quick profile on a plane (rect with optional corner r, circle, slot, polygon). XY extrudes along +Z from z=offset, XZ along +Y, YZ along +X; a negative distance goes the other way; symmetric centers it on the sketch plane.',
  {
    sketch: z.string().optional().describe('Name of a sketch; its plane and offset are used'),
    plane: plane.optional().describe('With profile: sketch plane'),
    offset: expr.optional().describe('With profile: distance of the sketch plane from the origin along its normal'),
    profile: profile.optional(),
    distance: expr.describe('Extrusion length; negative goes the other way'),
    symmetric: z.boolean().optional().describe('Extrude distance/2 to both sides'),
    ...placement,
  },
  [
    { name: 'plate', sketch: 'plate_outline', distance: 'plate_t' },
    { name: 'lid', plane: 'XY', offset: 'case_h', profile: { kind: 'rect', w: 'case_w', h: 'case_d', r: 3 }, distance: 2 },
    { name: 'usb_hole', plane: 'YZ', offset: -40, profile: { kind: 'slot', length: 9.5, width: 3.5, center: [0, 6] }, distance: 10 },
  ],
)

featureCommand(
  'revolve',
  'revolve',
  'Revolve a closed outline (sketch or profile) about an axis through the origin that lies in its plane: XZ sketches about Z (lathe-like parts: knobs, bushings) or X, XY about X or Y, YZ about Y or Z. The outline must not cross the axis.',
  {
    sketch: z.string().optional(),
    plane: plane.optional(),
    profile: profile.optional(),
    axis: z.enum(['X', 'Y', 'Z']),
    angle: expr.optional().describe('Degrees, default 360'),
    ...placement,
  },
  [{ name: 'knob', sketch: 'knob_profile', axis: 'Z' }],
)

define({
  name: 'loft',
  group: 'cad',
  kind: 'mutate',
  description:
    'Blend a solid through 2 or more cross-sections in order (e.g. a rectangle at the base to a circle at the top: funnels, transitions, tapered bosses). Each section is a sketch or a profile on a plane with an offset; sections are usually parallel and spaced along the normal. Each must be one closed loop without holes (cut holes afterwards). ruled: straight faces between sections instead of a smooth blend.',
  args: z.object({
    ...common,
    sections: z
      .array(
        z.object({
          sketch: z.string().optional().describe('Name of a sketch'),
          plane: plane.optional(),
          offset: expr.optional().describe('Distance of the plane from the origin along its normal'),
          profile: profile.optional(),
        }),
      )
      .min(2),
    ruled: z.boolean().optional(),
    ...placement,
    replace,
  }),
  examples: [
    {
      name: 'funnel',
      sections: [
        { plane: 'XY', offset: 0, profile: { kind: 'rect', w: 30, h: 30, r: 2 } },
        { plane: 'XY', offset: 25, profile: { kind: 'circle', r: 6 } },
      ],
    },
  ],
  apply(doc, a) {
    const { replace: r, ...rest } = a
    return upsert(doc, compact({ ...rest, type: 'loft' }) as unknown as Feature, r)
  },
})

define({
  name: 'sweep',
  group: 'cad',
  kind: 'mutate',
  description:
    'Sweep a cross-section along a 3D path (cable channels, handles, bent rods, gaskets). The path goes straight through the points; bend rounds every corner with that radius (recommended, sharp corners are mitered). The cross-section (profile or sketch, in its own u/v coordinates) is centered on the first point, perpendicular to the first segment; u is horizontal (perpendicular to the path and Z) and v is up. One loop without holes: for a tube sweep the inner profile too and cut it.',
  args: z.object({
    ...common,
    profile: profile.optional(),
    sketch: z.string().optional().describe('Use a sketch\'s outline as the cross-section (its plane is ignored)'),
    path: z.array(vec3).min(2).describe('Path points [x, y, z] in order'),
    bend: expr.optional().describe('Corner radius of the path; 0 = sharp'),
    ...placement,
    replace,
  }),
  examples: [
    {
      name: 'handle',
      profile: { kind: 'circle', r: 4 },
      path: [
        [-30, 0, 0],
        [-30, 0, 25],
        [30, 0, 25],
        [30, 0, 0],
      ],
      bend: 8,
    },
  ],
  apply(doc, a) {
    const { replace: r, ...rest } = a
    return upsert(doc, compact({ ...rest, type: 'sweep' }) as unknown as Feature, r)
  },
})

// ── Operations ──────────────────────────────────────────────────────────

featureCommand(
  'boolean',
  'boolean',
  'Combine features: union merges the tools into the target, cut subtracts them, intersect keeps the common volume. Inputs are consumed: only the result is a visible body. To cut a hole, first add the tool body (box, cylinder, extrude), then cut it from the target.',
  {
    op: z.enum(['union', 'cut', 'intersect']),
    target: featureRef,
    tools: z.array(featureRef).min(1),
  },
  [{ name: 'case_open', op: 'cut', target: 'case_shell', tools: ['usb_hole', 'led_hole'] }],
)

featureCommand(
  'fillet',
  'fillet',
  'Round edges of a feature with radius r. Select edges with a selector; without one all edges are rounded. Fillet last when you can: shell and cuts on filleted bodies fail more often.',
  { target: featureRef, r: expr, edges: selector.optional() },
  [{ name: 'case_round', target: 'case_body', r: 3, edges: { where: '|Z' } }],
)

featureCommand(
  'chamfer',
  'chamfer',
  'Bevel edges of a feature by distance d. Select edges with a selector; without one all edges are chamfered.',
  { target: featureRef, d: expr, edges: selector.optional() },
  [{ name: 'base_chamfer', target: 'case_body', d: 0.5, edges: { where: '<Z' } }],
)

featureCommand(
  'shell',
  'shell',
  'Hollow a solid into walls of the given thickness, removing the faces picked by open (default the top face, ">Z"). Walls grow inwards, so outer dimensions stay.',
  { target: featureRef, thickness: expr, open: selector.optional() },
  [{ name: 'case_shell', target: 'case_round', thickness: 'wall', open: { where: '>Z' } }],
)

featureCommand(
  'transform',
  'transform',
  'Move and/or rotate a copy of a feature; the original is consumed.',
  { target: featureRef, ...placement },
  [{ name: 'lid_placed', target: 'lid', translate: [0, 0, 30], rotate: [180, 0, 0] }],
)

define({
  name: 'pattern',
  group: 'cad',
  kind: 'mutate',
  description:
    'Repeat a feature: linear (count copies, each moved by step [x,y,z] from the previous) or grid (count [nx, ny] copies with step [dx, dy] on XY). The copies are fused into one body; use it as a tool to cut many holes at once.',
  args: z
    .object({
      ...common,
      kind: z.enum(['linear', 'grid']),
      target: featureRef,
      count: z.union([expr, vec2]).describe('linear: number of copies; grid: [nx, ny]'),
      step: z.union([vec3, vec2]).describe('linear: [dx, dy, dz] between copies; grid: [dx, dy]'),
      replace,
    })
    .superRefine((a, ctx) => {
      if (a.kind === 'linear' && (Array.isArray(a.count) || !Array.isArray(a.step) || a.step.length !== 3)) {
        ctx.addIssue({ code: 'custom', message: 'linear needs count as a number and step as [dx, dy, dz]' })
      }
      if (a.kind === 'grid' && (!Array.isArray(a.count) || !Array.isArray(a.step) || a.step.length !== 2)) {
        ctx.addIssue({ code: 'custom', message: 'grid needs count as [nx, ny] and step as [dx, dy]' })
      }
    }),
  examples: [
    { name: 'vents', kind: 'linear', target: 'vent_slot', count: 6, step: [4, 0, 0] },
    { name: 'standoffs', kind: 'grid', target: 'standoff', count: [2, 2], step: ['hole_dx', 'hole_dy'] },
  ],
  apply(doc, a) {
    const { replace: r, ...rest } = a as Record<string, unknown> & { replace?: boolean }
    return upsert(doc, compact({ ...rest, type: 'pattern' }) as unknown as Feature, r)
  },
})

define({
  name: 'update_feature',
  group: 'cad',
  kind: 'mutate',
  description:
    'Change some fields of an existing feature without restating it, e.g. {"name":"case_round","set":{"r":2}}. Use null to remove an optional field. The feature type cannot change; use the feature command with replace: true for that.',
  args: z.object({
    name: featureRef,
    set: z.record(z.string(), z.unknown()).describe('Fields to change, as in the feature command'),
  }),
  examples: [{ name: 'case_body', set: { size: ['case_w', 'case_d', 30] } }],
  apply(doc, a) {
    const next = clone(doc)
    const i = next.features.findIndex((f) => f.name === a.name)
    if (i < 0) throw new Error(`no feature "${a.name}"; features are: ${next.features.map((f) => f.name).join(', ') || '(none)'}`)
    if ('type' in a.set || 'name' in a.set) throw new Error('set cannot change type or name; use rename_feature or the feature command with replace: true')
    const f = { ...next.features[i] } as Record<string, unknown>
    for (const [k, v] of Object.entries(a.set)) {
      if (v === null) delete f[k]
      else f[k] = v
    }
    next.features[i] = f as unknown as Feature
    return { doc: next, summary: `updated ${a.name}: ${Object.keys(a.set).join(', ')}` }
  },
})

define({
  name: 'set_appearance',
  group: 'cad',
  kind: 'mutate',
  description:
    'Set how bodies look in the viewport: a color and an opacity (0.05..1; e.g. 0.3 for a see-through case that shows the board inside). Display only: geometry, exports and checks do not change. null resets to the default. Verify with render.',
  args: z.object({
    names: z.array(featureRef).min(1).describe('Bodies to change'),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb, e.g. "#4a90d9"')
      .nullable()
      .optional()
      .describe('#rrggbb, or null for the default grey'),
    opacity: z.number().min(0.05).max(1).nullable().optional().describe('0.05..1, or null for opaque'),
  }),
  examples: [{ names: ['case_body'], opacity: 0.3 }, { names: ['button_cap'], color: '#d6a100' }],
  apply(doc, a) {
    if (a.color === undefined && a.opacity === undefined) throw new Error('set color, opacity or both (null resets one)')
    const next = clone(doc)
    for (const n of a.names) {
      const i = next.features.findIndex((f) => f.name === n)
      if (i < 0) throw new Error(`no feature "${n}"; features are: ${next.features.map((f) => f.name).join(', ') || '(none)'}`)
      const f = { ...next.features[i] }
      if (a.color === null) delete f.color
      else if (a.color !== undefined) f.color = a.color.toLowerCase()
      if (a.opacity === null || a.opacity === 1) delete f.opacity
      else if (a.opacity !== undefined) f.opacity = Math.round(a.opacity * 100) / 100
      next.features[i] = f
    }
    const what = [a.color !== undefined && `color ${a.color ?? 'default'}`, a.opacity !== undefined && `opacity ${a.opacity ?? 1}`].filter(Boolean).join(', ')
    return { doc: next, summary: `${a.names.join(', ')}: ${what}` }
  },
})

define({
  name: 'rename_feature',
  group: 'cad',
  kind: 'mutate',
  description: 'Rename a feature and every reference to it.',
  args: z.object({ name: featureRef, to: featureName }),
  apply(doc, a) {
    const next = clone(doc)
    if (!findFeature(next, a.name)) throw new Error(`no feature "${a.name}"`)
    if (findFeature(next, a.to)) throw new Error(`"${a.to}" exists already`)
    const ren = (n: string) => (n === a.name ? a.to : n)
    next.features = next.features.map((f) => {
      const g = { ...f, name: ren(f.name) } as Record<string, unknown>
      if (typeof g.target === 'string') g.target = ren(g.target)
      if (Array.isArray(g.tools)) g.tools = (g.tools as string[]).map(ren)
      return g as unknown as Feature
    })
    next.checks = next.checks.map((c) => {
      const g = { ...c } as Record<string, unknown>
      for (const k of ['a', 'b', 'inner', 'outer', 'target']) if (typeof g[k] === 'string') g[k] = ren(g[k] as string)
      return g as unknown as typeof c
    })
    return { doc: next, summary: `renamed ${a.name} → ${a.to}` }
  },
})

define({
  name: 'delete_features',
  group: 'cad',
  kind: 'mutate',
  description: 'Delete features. Fails while another feature or a check uses one of them, unless cascade is true (then the users are deleted too).',
  args: z.object({ names: z.array(featureRef).min(1), cascade: z.boolean().optional() }),
  apply(doc, a) {
    const next = clone(doc)
    const drop = new Set(a.names)
    for (const n of a.names) if (!findFeature(next, n)) throw new Error(`no feature "${n}"`)
    // Grow the set with every feature that (transitively) uses a dropped one.
    let grew = true
    const users: string[] = []
    while (grew) {
      grew = false
      for (const f of next.features) {
        if (drop.has(f.name)) continue
        const used = inputsOf(f).filter((i) => drop.has(i))
        if (used.length) {
          users.push(`${f.name} uses ${used.join(', ')}`)
          if (a.cascade) {
            drop.add(f.name)
            grew = true
          }
        }
      }
    }
    if (users.length && !a.cascade) throw new Error(`cannot delete: ${users.join('; ')}. Pass cascade: true to delete them too.`)
    next.features = next.features.filter((f) => !drop.has(f.name))
    const refs = (c: Record<string, unknown>) => ['a', 'b', 'inner', 'outer', 'target'].some((k) => drop.has(c[k] as string))
    const droppedChecks = next.checks.filter((c) => refs(c as never)).map((c) => c.name)
    next.checks = next.checks.filter((c) => !refs(c as never))
    return {
      doc: next,
      summary: `deleted ${[...drop].join(', ')}${droppedChecks.length ? `; removed checks ${droppedChecks.join(', ')}` : ''}`,
    }
  },
})

// ── Checks ──────────────────────────────────────────────────────────────

define({
  name: 'set_checks',
  group: 'checks',
  kind: 'mutate',
  description:
    'Add or replace (by name) design checks: requirements that run_checks verifies after every change. Write the requirements first, then model, then run_checks. Kinds: expr (boolean over parameters), min_distance (clearance between two bodies), no_overlap, inside (inner fits in outer with margin), volume (min/max).',
  args: z.object({ checks: z.array(checkDef).min(1) }),
  examples: [
    {
      checks: [
        { name: 'wall_printable', kind: 'expr', expr: 'wall >= 1.2', note: 'FDM minimum' },
        { name: 'board_fits', kind: 'inside', inner: 'pcb', outer: 'cavity', margin: 0.3 },
      ],
    },
  ],
  apply(doc, a) {
    const next = clone(doc)
    for (const c of a.checks) {
      const i = next.checks.findIndex((x) => x.name === c.name)
      if (i >= 0) next.checks[i] = compact(c) as never
      else next.checks.push(compact(c) as never)
    }
    return { doc: next, summary: `set checks ${a.checks.map((c) => c.name).join(', ')}` }
  },
})

define({
  name: 'delete_checks',
  group: 'checks',
  kind: 'mutate',
  description: 'Delete design checks by name.',
  args: z.object({ names: z.array(z.string()).min(1) }),
  apply(doc, a) {
    const next = clone(doc)
    const missing = a.names.filter((n) => !next.checks.some((c) => c.name === n))
    if (missing.length) throw new Error(`no check ${missing.join(', ')}`)
    next.checks = next.checks.filter((c) => !a.names.includes(c.name))
    return { doc: next, summary: `deleted checks ${a.names.join(', ')}` }
  },
})

define({
  name: 'set_description',
  group: 'project',
  kind: 'mutate',
  description: 'Set the design brief: what is being built and the key requirements, in a few lines. It is shown to every agent that opens the project.',
  args: z.object({ description: z.string() }),
  apply(doc, a) {
    const next = clone(doc)
    next.meta = { ...next.meta, description: a.description }
    return { doc: next, summary: 'updated description' }
  },
})

// batch is recorded as one op holding its steps; replay applies them in
// order. The session validates and runs it (see Session.execBatch).
define({
  name: 'batch',
  group: 'project',
  kind: 'mutate',
  description:
    'Apply several changes atomically as one step (one undo): if any step fails, nothing changes and the error names the step. Use it to build a whole part in one call. Steps are change commands only (no queries).',
  args: z.object({
    steps: z
      .array(
        z.object({
          cmd: z.string().describe('A change command, e.g. "box", "boolean", "set_parameters"'),
          args: z.record(z.string(), z.unknown()).describe('Its arguments, as when calling it directly'),
        }),
      )
      .min(1),
  }),
  examples: [
    {
      steps: [
        { cmd: 'set_parameters', args: { parameters: [{ name: 'w', expr: 40 }] } },
        { cmd: 'box', args: { name: 'body', size: ['w', 20, 10] } },
        { cmd: 'fillet', args: { name: 'body_round', target: 'body', r: 2, edges: { where: '|Z' } } },
      ],
    },
  ],
  apply(doc, a) {
    let next = doc
    const summaries: string[] = []
    a.steps.forEach((s, i) => {
      if (s.cmd === 'batch') throw new Error(`step ${i + 1}: batches cannot be nested`)
      try {
        const out = applyOp(next, { cmd: s.cmd, args: s.args })
        next = out.doc
        summaries.push(out.summary)
      } catch (e) {
        throw new Error(`step ${i + 1} (${s.cmd}) failed, nothing was changed: ${(e as Error).message}`)
      }
    })
    return { doc: next, summary: summaries.join('; ') }
  },
})
