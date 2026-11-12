// Drawings: 2D technical drawings of bodies (SVG, PDF, DXF) and flat
// outlines as DXF for laser and waterjet cutting.

import { z } from 'zod'

import { layoutSheet, PAPER, sheetDXF, sheetPDF, sheetSVG, writeDXF } from './drawing'
import { define } from './registry'
import { featureRef, selector } from './schema'
import { requireHealthyHistory } from './operations'

const VIEWS = ['front', 'top', 'right', 'left', 'back', 'bottom', 'iso'] as const

define({
  name: 'drawing',
  group: 'query',
  kind: 'query',
  description:
    'Make a 2D technical drawing of bodies: hidden-line views (default front, top, right and iso; third-angle projection: top above front, right beside it), visible edges solid and hidden edges dashed, overall dimensions, a standard scale that fits the paper, and a title block. Returns the scale, view sizes and dimensions to check, and downloads the sheet as SVG, PDF or DXF (format). Default bodies: every visible B-rep body except the board parts. For a cut-away use section; for a laser-cut outline use export_dxf.',
  args: z.object({
    names: z.array(featureRef).optional().describe('Bodies to draw (default: all visible bodies except board parts)'),
    views: z.array(z.enum(VIEWS)).min(1).max(7).optional(),
    format: z.enum(['svg', 'pdf', 'dxf']).optional().describe('File to download (default svg); without a browser only the summary is returned'),
    paper: z.enum(Object.keys(PAPER) as [keyof typeof PAPER, ...(keyof typeof PAPER)[]]).optional().describe('Sheet size, landscape (default A4)'),
    scale: z.number().positive().optional().describe('Sheet mm per model mm, e.g. 0.5 for 1:2 (default: the largest standard scale that fits)'),
    title: z.string().max(80).optional(),
    filename: z.string().optional(),
  }),
  async run(ctx, a) {
    requireHealthyHistory(ctx)
    const build = await ctx.kernel.build()
    const names = a.names ?? build.bodies.filter((n) => !n.startsWith('part_'))
    const views = await ctx.kernel.views(names, a.views ?? ['front', 'top', 'right', 'iso'])
    const empty = views.filter((v) => !v.visible.length).map((v) => v.name)
    const title = a.title ?? (ctx.doc.meta.description?.split(/[.\n]/)[0]?.slice(0, 60) || names.join(', '))
    const sheet = layoutSheet(views, { title, paper: a.paper, scale: a.scale, notes: ctx.doc.configuration ? [`Configuration: ${ctx.doc.configuration}`] : [] })
    const format = a.format ?? 'svg'
    const svg = sheetSVG(sheet)
    const size = (v: (typeof views)[number]) => [v.box[1][0] - v.box[0][0], v.box[1][1] - v.box[0][1]].map((x) => Math.round(x * 100) / 100)
    const out: Record<string, unknown> = {
      ok: true,
      paper: `${a.paper ?? 'A4'} ${sheet.width} × ${sheet.height} mm`,
      scale: sheet.scale >= 1 ? `${sheet.scale}:1` : `1:${Math.round(1 / sheet.scale)}`,
      views: views.map((v) => ({ name: v.name, size: size(v), visible_lines: v.visible.length, hidden_lines: v.hidden.length })),
      dimensions: sheet.dimensions.map((d) => d.text),
      ...(empty.length ? { warning: `no visible edges in ${empty.join(', ')}` } : {}),
    }
    if (ctx.download) {
      const file = a.filename ?? `drawing.${format}`
      const blob =
        format === 'pdf' ? new Blob([sheetPDF(sheet) as BlobPart], { type: 'application/pdf' }) : format === 'dxf' ? new Blob([sheetDXF(sheet)], { type: 'application/dxf' }) : new Blob([svg], { type: 'image/svg+xml' })
      await ctx.download(file, blob)
      out.file = file
      out.bytes = blob.size
    }
    return out
  },
})

define({
  name: 'export_dxf',
  group: 'query',
  kind: 'query',
  description:
    'Download a flat outline as DXF (R12, mm) for laser, waterjet or CNC cutting: a sketch (its closed loops, holes included), or one flat face of a body picked by selector (its outer edge and holes, in the face\'s own (u, v) as for a sketch on a face). Returns the loop count, size and area so the result can be checked.',
  args: z
    .object({
      sketch: z.string().optional().describe('A sketch to export'),
      feature: featureRef.optional().describe('A body whose face to export'),
      face: selector.optional().describe('With feature: picks one flat face, e.g. { where: ">Z" }'),
      filename: z.string().optional(),
    })
    .refine((x) => !!x.sketch !== !!x.feature, { message: 'give either sketch, or feature with face' })
    .refine((x) => !x.feature || !!x.face, { message: 'feature needs face (a selector that picks one flat face)' }),
  async run(ctx, a) {
    requireHealthyHistory(ctx)
    const source = a.sketch ? { sketch: a.sketch } : { feature: a.feature!, face: a.face! }
    const { loops } = await ctx.kernel.profile(source)
    if (!loops.length) throw new Error('the outline has no closed loops')
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    // Material area: the largest loop (outline) minus the others (holes), whatever their winding.
    const areas = loops.map((l) => {
      let s = 0
      for (let i = 0; i + 1 < l.length; i++) {
        s += l[i][0] * l[i + 1][1] - l[i + 1][0] * l[i][1]
        x0 = Math.min(x0, l[i][0])
        x1 = Math.max(x1, l[i][0])
        y0 = Math.min(y0, l[i][1])
        y1 = Math.max(y1, l[i][1])
      }
      return Math.abs(s / 2)
    })
    const outer = Math.max(...areas)
    const area = outer - (areas.reduce((s, x) => s + x, 0) - outer)
    const r2 = (v: number) => Math.round(v * 100) / 100
    const out: Record<string, unknown> = { ok: true, loops: loops.length, size: [r2(x1 - x0), r2(y1 - y0)], area: r2(area), units: 'mm', note: 'area assumes one outline with holes inside it' }
    if (ctx.download) {
      const file = a.filename ?? `${a.sketch ?? a.feature}.dxf`
      const blob = new Blob([writeDXF({ CUT: loops })], { type: 'application/dxf' })
      await ctx.download(file, blob)
      out.file = file
      out.bytes = blob.size
    }
    return out
  },
})
