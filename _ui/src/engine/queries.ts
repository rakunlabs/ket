// Query commands: how a model sees the design. Answers are compact and
// numeric first (bounding boxes, volumes, distances, check results); render
// adds pictures for models that can see.

import { z } from 'zod'

import { type Doc, bodies, dependsOn, effectiveParameters, inputsOf, withConfiguration } from './doc'
import type { BuildResult } from './kernel'
import { urlFile } from './model-files'
import { explodeOffset } from './explode'
import { type Ctx, type KernelAPI, command, configKernel, define } from './registry'
import { featureRef, selector } from './schema'
import { requireHealthyHistory } from './operations'

/** Compact, readable view of the document and its build state. */
export function summarize(doc: Doc, build: BuildResult, detail: 'summary' | 'full' = 'summary') {
  const status = new Map(build.features.map((f) => [f.name, f]))
  const used = new Set(doc.features.flatMap(inputsOf))

  return {
    description: doc.meta.description,
    units: doc.units,
    ok: build.ok,
    parameter_error: build.parameterError,
    parameters: effectiveParameters(doc).map((p) => {
      const v = build.parameters[p.name]
      const line = typeof p.expr === 'number' || String(v) === String(p.expr) ? `${p.name} = ${p.expr}` : `${p.name} = ${p.expr} → ${v ?? '?'}`
      const base = doc.parameters.find((x) => x.name === p.name)
      return base && base.expr !== p.expr ? `${line} (configuration ${doc.configuration}; base ${base.expr})` : line
    }),
    ...(doc.configurations?.length
      ? { configurations: doc.configurations.map((c) => ({ name: c.name, values: c.values, ...(c.note ? { note: c.note } : {}) })), active_configuration: doc.configuration ?? null }
      : {}),
    features: doc.features.map((f) => {
      const st = status.get(f.name)
      const base: Record<string, unknown> =
        detail === 'full' ? { ...f } : { name: f.name, type: f.type, ...(inputsOf(f).length ? { from: inputsOf(f) } : {}) }
      if (!used.has(f.name) && !f.hidden) base.body = true
      if (st?.ok) {
        base.bbox = st.bbox
        if (detail === 'full' || !used.has(f.name)) base.volume = st.volume
      } else if (st) {
        base.error = st.error
      }
      if (st?.warnings?.length) base.warnings = st.warnings
      return base
    }),
    checks: doc.checks.map((c) => c.name),
    sketches: (doc.sketches ?? []).map((s) => {
      const st = build.sketches?.find((x) => x.name === s.name)
      const out: Record<string, unknown> = { name: s.name, plane: s.plane, status: st?.status, dof: st?.dof, loops: st?.loops }
      if (st?.message) out.message = st.message
      if (detail === 'full') Object.assign(out, { points: s.points, entities: s.entities, constraints: s.constraints })
      return out
    }),
    bodies: build.bodies,
    materials: doc.materials?.length
      ? doc.materials.map((m) => ({ name: m.name, used_by: doc.features.filter((f) => f.material === m.name).map((f) => f.name), ...(detail === 'full' ? m : {}) }))
      : undefined,
    decals: doc.decals?.length ? (detail === 'full' ? doc.decals : `${doc.decals.length} on ${[...new Set(doc.decals.map((d) => d.target))].join(', ')}`) : undefined,
    appearance_problems: build.appearance,
    pcb: doc.pcb ? { components: doc.pcb.components.length, nets: doc.pcb.nets.length, tracks: doc.pcb.tracks.length, vias: doc.pcb.vias.length, artwork: doc.pcb.artwork?.length ?? 0, hint: 'Use get_board, get_copper and get_problems for PCB definitions, electrical coverage and diagnostics.' } : undefined,
  }
}

define({
  name: 'get_document',
  group: 'query',
  kind: 'query',
  description:
    'Read the design: parameters (with resolved values), features in order with their inputs, bounding boxes, volumes, errors and warnings, the checks and the visible bodies. Start every task with it. detail "full" includes every field of every feature.',
  args: z.object({ detail: z.enum(['summary', 'full']).optional() }),
  async run(ctx, a) {
    return { ...summarize(ctx.doc, await ctx.kernel.build(), a.detail ?? 'summary'), ...(ctx.recovery ? { ok: false, recovery: ctx.recovery } : {}), ...(ctx.revision !== undefined ? { revision: ctx.revision } : {}) }
  },
})

define({
  name: 'get_feature',
  group: 'query',
  kind: 'query',
  description: 'Read one feature: its full definition and build status (bbox, volume, faces, edges, errors).',
  args: z.object({ name: featureRef }),
  async run(ctx, a) {
    const f = ctx.doc.features.find((x) => x.name === a.name)
    if (!f) throw new Error(`no feature "${a.name}"; features are: ${ctx.doc.features.map((x) => x.name).join(', ') || '(none)'}`)
    const st = (await ctx.kernel.build()).features.find((x) => x.name === a.name)
    const usedBy = ctx.doc.features.filter((x) => dependsOn(x, ctx.doc).includes(a.name)).map((x) => x.name)
    return { definition: f, status: st, used_by: usedBy }
  },
})

define({
  name: 'list_faces',
  group: 'query',
  kind: 'query',
  description:
    'List the faces of a feature with index, type, center, normal and area, optionally filtered by a selector. Use it to check what a selector picks before fillet/shell, or to find where to place the next feature.',
  args: z.object({ name: featureRef, selector: selector.optional(), limit: z.number().int().positive().optional() }),
  async run(ctx, a) {
    const all = await ctx.kernel.faces(a.name, a.selector)
    const limit = a.limit ?? 60
    return { count: all.length, faces: all.slice(0, limit), truncated: all.length > limit || undefined }
  },
})

define({
  name: 'list_edges',
  group: 'query',
  kind: 'query',
  description: 'List the edges of a feature with index, type, start, end and length, optionally filtered by a selector.',
  args: z.object({ name: featureRef, selector: selector.optional(), limit: z.number().int().positive().optional() }),
  async run(ctx, a) {
    const all = await ctx.kernel.edges(a.name, a.selector)
    const limit = a.limit ?? 60
    return { count: all.length, edges: all.slice(0, limit), truncated: all.length > limit || undefined }
  },
})

define({
  name: 'measure',
  group: 'query',
  kind: 'query',
  description:
    'Measure a feature: bounding box, size, volume, surface area, center of mass. With other: also the minimum distance between the two and the volume they overlap (0 = no collision).',
  args: z.object({ name: featureRef, other: featureRef.optional() }),
  async run(ctx, a) {
    return ctx.kernel.measure(a.name, a.other)
  },
})

const vec3n = z.tuple([z.number(), z.number(), z.number()])
const target = z.union([featureRef, vec3n]).describe('A feature name or a point [x, y, z] in mm')

define({
  name: 'measure_between',
  group: 'query',
  kind: 'query',
  description:
    'Distance between two things, each a feature (body, part_<REF>, board) or a point [x, y, z]. Two features: the minimum gap and their overlap volume; point and feature: the gap from the point to the surface (0 when inside); two points: the distance and the vector between them. Use it for clearances, e.g. a connector to the case wall.',
  args: z.object({ a: target, b: target }),
  examples: [{ a: 'part_J1', b: 'case' }, { a: [0, 0, 0], b: [10, 5, 2] }],
  async run(ctx, a) {
    return ctx.kernel.between(a.a, a.b)
  },
})

define({
  name: 'list_solids',
  group: 'query',
  kind: 'query',
  description:
    'List the separate solids of a body (the pieces of a printed set, the parts of an imported plate) with index, bounding box, size, box center and volume. Take one or some as a new body with the solids command (pick by near, inBox, index or largest).',
  args: z.object({ name: featureRef }),
  examples: [{ name: 'pieces' }],
  async run(ctx, a) {
    const list = await ctx.kernel.solids(a.name)
    return { name: a.name, count: list.length, solids: list.slice(0, 200), ...(list.length > 200 ? { more: list.length - 200 } : {}) }
  },
})

define({
  name: 'section',
  group: 'query',
  kind: 'query',
  description:
    'Cut bodies with a plane and read the cut as numbers: per body the closed outlines in the plane (material and hole loops, each with its area and box, and its points when it is small), and the total cut area. Plane X=at gives (y, z) outlines, Y=at (x, z), Z=at (x, y). Comes with a drawing of the cut (filled outlines per body on a millimetre grid) to look at. Use it to find walls, pockets, free space and wall thickness in imported models before editing them.',
  args: z.object({
    names: z.array(featureRef).min(1).max(8).optional().describe('Bodies to cut (default every visible body)'),
    axis: z.enum(['X', 'Y', 'Z']),
    at: z.number().describe('Coordinate of the plane in mm'),
    image: z.boolean().optional().describe('Also return a picture of the cut: filled outlines on a mm grid (default true)'),
  }),
  examples: [{ names: ['cover'], axis: 'Z', at: 10 }],
  async run(ctx, a) {
    const names = a.names ?? (await ctx.kernel.build()).bodies
    const r = await ctx.kernel.section(names, a.axis, a.at)
    return { axis: a.axis, at: a.at, bodies: r.bodies, ...(r.image && a.image !== false ? { images: [{ mime: 'image/png', data: r.image }] } : {}) }
  },
})

define({
  name: 'get_gears',
  group: 'query',
  kind: 'query',
  description:
    'List the gears as solved: kind, teeth, module, pitch/tip/root diameters, center, axis, rotation (racks: travel), helix or lead angle, which gear each meshes with or shares a shaft with, the turns per turn of the first gear (sign = direction) and warnings (undercut, hands, self-locking worms). Use it to check a train before rendering.',
  args: z.object({}),
  async run(ctx) {
    const gears = await ctx.kernel.gears()
    return { count: gears.length, gears }
  },
})

define({
  name: 'run_checks',
  group: 'query',
  kind: 'query',
  description:
    'Rebuild and verify the design: every feature must build, and every check (set_checks) must pass. Run it after each group of changes and fix what fails before going on.',
  args: z.object({
    configurations: z
      .union([z.literal('all'), z.array(z.string()).min(1)])
      .optional()
      .describe('Also verify these configurations ("all": every one), each built on its own; default only the active design'),
  }),
  async run(ctx, a) {
    const report = await checkReport(ctx.kernel, ctx.recovery)
    if (!a.configurations) return report
    const names = a.configurations === 'all' ? (ctx.doc.configurations ?? []).map((c) => c.name) : a.configurations
    if (!names.length) throw new Error('the design has no configurations; add one with set_configuration')
    const variants: Record<string, unknown>[] = []
    try {
      for (const name of names) {
        const r = await checkReport(configKernel(ctx, withConfiguration(ctx.doc, name)), ctx.recovery)
        variants.push({ configuration: name, ok: r.ok, summary: r.summary, parameter_error: r.parameter_error, failed_features: r.failed_features, failed_checks: r.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })) })
      }
    } finally {
      // Leave the kernel on the active design for whatever runs next.
      await ctx.kernel.build()
    }
    return { ...report, ok: report.ok && variants.every((v) => v.ok), active: ctx.doc.configuration ?? '(base parameters)', configurations: variants }
  },
})

async function checkReport(kernel: KernelAPI, recovery: Ctx['recovery']) {
  const build = await kernel.build()
  const checks = await kernel.checks()
  const failedFeatures = build.features.filter((f) => !f.ok).map((f) => ({ name: f.name, error: f.error }))
  const warnings = build.features.filter((f) => f.warnings?.length).map((f) => ({ name: f.name, warnings: f.warnings }))
  const failedChecks = checks.filter((c) => !c.ok)
  const slow = build.features
    .filter((f) => f.ms)
    .sort((x, y) => y.ms! - x.ms!)
    .slice(0, 5)
    .map((f) => `${f.name} ${(f.ms! / 1000).toFixed(1)} s`)
  return {
    ok: build.ok && failedChecks.length === 0 && !recovery,
    recovery,
    slow_features: slow.length ? slow : undefined,
    timing_ms: build.timing,
    summary: `${build.features.length - failedFeatures.length}/${build.features.length} features built, ${checks.length - failedChecks.length}/${checks.length} checks pass`,
    parameter_error: build.parameterError,
    failed_features: failedFeatures.length ? failedFeatures : undefined,
    warnings: warnings.length ? warnings : undefined,
    appearance_problems: build.appearance,
    checks,
    hint: checks.length === 0 ? 'No checks yet: add the requirements with set_checks so changes can be verified.' : undefined,
  }
}

const VIEWS = ['iso', 'iso_back', 'top', 'bottom', 'front', 'back', 'left', 'right'] as const

define({
  name: 'render',
  group: 'query',
  kind: 'query',
  description:
    'Render the model to images to see it. Default views: iso and top. Front looks along +Y (from -Y), right looks along -X, top looks down -Z. highlight draws the named features in orange; hide leaves features out (e.g. a lid); section cuts the view at a plane to look inside. Images come with a short text legend.',
  args: z.object({
    views: z.array(z.enum(VIEWS)).min(1).max(6).optional(),
    size: z.number().int().min(128).max(1024).optional().describe('Pixels per side (default 512)'),
    edges: z.boolean().optional().describe('Draw B-rep edge lines (default true; false also switches to realistic shading)'),
    shading: z
      .enum(['normal', 'realistic', 'wireframe', 'xray'])
      .optional()
      .describe('normal: CAD colors and edges (default); realistic: materials, decals and reflections as the product looks; wireframe: edges only; xray: see-through bodies to check what is inside'),
    highlight: z.array(featureRef).optional(),
    hide: z.array(featureRef).optional(),
    section: z
      .object({ axis: z.enum(['X', 'Y', 'Z']), at: z.number().describe('Coordinate of the cut plane in mm') })
      .optional()
      .describe('Remove everything on the positive side of the plane'),
    explode: z.number().min(0).max(1).optional().describe('Draw the exploded view (set_explode) at this fraction: 1 fully apart, 0 assembled (default)'),
  }),
  async run(ctx, a) {
    if (!ctx.render) throw new Error('render is only available in the browser')
    const build = await ctx.kernel.build()
    let offsets: Record<string, [number, number, number]> | undefined
    if (a.explode) {
      if (!ctx.doc.explode?.steps.length) throw new Error('no exploded view yet; define one with set_explode')
      offsets = {}
      const params = new Map(Object.entries(build.parameters))
      for (const name of build.bodies) {
        const e = explodeOffset(ctx.doc, params, name)
        if (e) offsets[name] = [e[0] * a.explode, e[1] * a.explode, e[2] * a.explode]
      }
    }
    const out = await ctx.render({
      views: a.views ?? ['iso', 'top'],
      size: a.size ?? 512,
      highlight: a.highlight,
      hide: a.hide,
      section: a.section,
      edges: a.edges ?? true,
      shading: a.shading,
      offsets,
    })
    const [lo, hi] = overallBox(build)
    return {
      text: `Rendered ${out.views.join(', ')}. Bodies: ${build.bodies.join(', ') || '(none)'}. Overall box ${fmt(lo)} → ${fmt(hi)} mm. Axes: X red, Y green, Z blue; grid 10 mm.${a.edges === false || a.shading ? '' : ' Pass shading: "realistic" to see materials and decals as they look.'}${build.appearance?.length ? ` Appearance problems: ${build.appearance.join('; ')}` : ''}`,
      images: out.images,
    }
  },
})

function overallBox(build: BuildResult): [number[], number[]] {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const f of build.features) {
    if (!f.bbox || !build.bodies.includes(f.name)) continue
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], f.bbox[0][i])
      hi[i] = Math.max(hi[i], f.bbox[1][i])
    }
  }
  if (!Number.isFinite(lo[0])) return [[0, 0, 0], [0, 0, 0]]
  return [lo, hi]
}

const fmt = (v: number[]) => `[${v.map((x) => Math.round(x * 100) / 100).join(', ')}]`

define({
  name: 'export',
  group: 'query',
  kind: 'query',
  description:
    'Export bodies as STEP (CAD exchange), STL or 3MF (3D printing; 3MF keeps one named object per body with its color). The file is downloaded in the user\'s browser. Default: all visible bodies. Triangle-mesh bodies (imported STL / 3MF and what is built from them) export to STL and 3MF only. Board parts export as their part_* blocks (courtyard × real model height); with detail: "models" STEP gets the vendor 3D models instead (meshes sewn into faces: true shapes for checking fit in another CAD tool, but larger files, about 20 MB per detailed part). To print an enclosure alone, pass names: ["case"].',
  args: z.object({
    format: z.enum(['step', 'stl', '3mf']),
    names: z.array(featureRef).optional(),
    filename: z.string().optional(),
    detail: z.enum(['blocks', 'models']).optional().describe('Board parts as blocks (default) or as vendor models (STEP)'),
    configuration: z.string().optional().describe('Export this configuration instead of the active design'),
  }),
  async run(ctx, a) {
    if (!ctx.download) throw new Error('export is only available in the browser')
    requireHealthyHistory(ctx)
    if (a.configuration !== undefined && a.configuration !== ctx.doc.configuration) {
      const doc = withConfiguration(ctx.doc, a.configuration)
      try {
        return await command('export')!.run!({ ...ctx, doc, kernel: configKernel(ctx, doc) }, { ...a, configuration: undefined, filename: a.filename ?? `model-${a.configuration}.${a.format}` })
      } finally {
        await ctx.kernel.build()
      }
    }
    const build = await ctx.kernel.build()
    const names = a.names ?? build.bodies
    const models: Record<string, string> = {}
    const missing: string[] = []
    if (a.detail === 'models') {
      if (!ctx.services?.getModel) throw new Error('vendor models are only available in the browser')
      await Promise.all(
        (ctx.doc.pcb?.components ?? []).map(async (c) => {
          if (!names.includes(`part_${c.ref}`)) return
          // A part with its own STEP/STL model is already the real body.
          if (c.model) return
          if (!c.footprint.model) return void missing.push(c.ref)
          try {
            models[c.ref] = await ctx.services!.getModel!(c.footprint.model.uuid)
          } catch {
            missing.push(c.ref)
          }
        }),
      )
    }
    const blob = await ctx.kernel.export(a.format, names, a.format === 'step' ? models : undefined)
    const file = a.filename ?? `model.${a.format}`
    await ctx.download(file, blob)
    return {
      ok: true,
      file,
      bytes: blob.size,
      bodies: names,
      ...(a.detail === 'models' ? { models: Object.keys(models).sort(), blocks_without_model: missing.length ? missing.sort() : undefined } : {}),
    }
  },
})

define({
  name: 'export_slicer_3mf',
  group: 'query',
  kind: 'query',
  description:
    'Write edited bodies back into the slicer project (Bambu Studio, Orca, Prusa 3MF) they were imported from, and download it: each body replaces the mesh of the 3MF object its import names, where it was on its plate. Print settings, plates, other objects, per-object settings and the color/support paint stay; painted triangles keep their paint through cuts, and new faces (pocket walls and floors) take the paint of the nearest original faces facing the same way. Check the paint and re-slice in the slicer (thumbnails are the old ones). Objects that share the same mesh (one object on two plates) change together: the answer lists them.',
  args: z.object({
    replace: z
      .array(z.object({ body: featureRef.describe('The edited body, e.g. "cover_spares"'), object: featureRef.describe('The import feature of the 3MF object it replaces, e.g. "cover"') }))
      .min(1),
    filename: z.string().optional(),
  }),
  examples: [{ replace: [{ body: 'cover_spares', object: 'cover' }] }],
  async run(ctx, a) {
    if (!ctx.download) throw new Error('export_slicer_3mf is only available in the browser')
    requireHealthyHistory(ctx)
    const r = await ctx.kernel.update3MF(a.replace)
    const base = (urlFile(r.file) || 'project.3mf').replace(/\.3mf$/i, '')
    const file = a.filename ?? `${base} (edited).3mf`
    await ctx.download(file, r.blob)
    return {
      ok: true,
      file,
      bytes: r.blob.size,
      replaced: r.replaced,
      ...(r.also_changed.length ? { also_changed: r.also_changed, note: 'these objects use the same mesh in the 3MF, so they changed too' } : {}),
    }
  },
})

export { bodies }
