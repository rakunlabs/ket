// Query commands: how a model sees the design. Answers are compact and
// numeric first (bounding boxes, volumes, distances, check results); render
// adds pictures for models that can see.

import { z } from 'zod'

import { type Doc, bodies, inputsOf } from './doc'
import type { BuildResult } from './kernel'
import { explodeOffset } from './explode'
import { define } from './registry'
import { featureRef, selector } from './schema'

/** Compact, readable view of the document and its build state. */
export function summarize(doc: Doc, build: BuildResult, detail: 'summary' | 'full' = 'summary') {
  const status = new Map(build.features.map((f) => [f.name, f]))
  const used = new Set(doc.features.flatMap(inputsOf))

  return {
    description: doc.meta.description,
    units: doc.units,
    ok: build.ok,
    parameter_error: build.parameterError,
    parameters: doc.parameters.map((p) => {
      const v = build.parameters[p.name]
      return typeof p.expr === 'number' || String(v) === String(p.expr)
        ? `${p.name} = ${p.expr}`
        : `${p.name} = ${p.expr} → ${v ?? '?'}`
    }),
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
    return summarize(ctx.doc, await ctx.kernel.build(), a.detail ?? 'summary')
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
    const usedBy = ctx.doc.features.filter((x) => inputsOf(x).includes(a.name)).map((x) => x.name)
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
  args: z.object({}),
  async run(ctx) {
    const build = await ctx.kernel.build()
    const checks = await ctx.kernel.checks()
    const failedFeatures = build.features.filter((f) => !f.ok).map((f) => ({ name: f.name, error: f.error }))
    const warnings = build.features.filter((f) => f.warnings?.length).map((f) => ({ name: f.name, warnings: f.warnings }))
    const failedChecks = checks.filter((c) => !c.ok)
    const slow = build.features
      .filter((f) => f.ms)
      .sort((x, y) => y.ms! - x.ms!)
      .slice(0, 5)
      .map((f) => `${f.name} ${(f.ms! / 1000).toFixed(1)} s`)
    return {
      ok: build.ok && failedChecks.length === 0,
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
  },
})

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
    'Export bodies as STEP (CAD exchange) or STL (3D printing). The file is downloaded in the user\'s browser. Default: all visible bodies. Board parts export as their part_* blocks (courtyard × real model height); with detail: "models" STEP gets the vendor 3D models instead (meshes sewn into faces: true shapes for checking fit in another CAD tool, but larger files, about 20 MB per detailed part). To print an enclosure alone, pass names: ["case"].',
  args: z.object({
    format: z.enum(['step', 'stl']),
    names: z.array(featureRef).optional(),
    filename: z.string().optional(),
    detail: z.enum(['blocks', 'models']).optional().describe('Board parts as blocks (default) or as vendor models (STEP)'),
  }),
  async run(ctx, a) {
    if (!ctx.download) throw new Error('export is only available in the browser')
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

export { bodies }
