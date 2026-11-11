import { z } from 'zod'

import { define, type Ctx } from '../registry'
import { fabFiles } from './fab'

export const MANUFACTURERS = {
  jlcpcb: { name: 'JLCPCB', quote: 'https://jlcpcb.com/quote', api: 'https://api.jlcpcb.com/docs/api-list' },
  pcbway: { name: 'PCBWay', quote: 'https://www.pcbway.com/orderonline.aspx', api: 'https://www.pcbway.com/api_cooperation.html' },
} as const

const options = z.object({
  manufacturer: z.enum(['jlcpcb', 'pcbway']).default('jlcpcb'),
  quantity: z.number().int().min(1).max(100000).default(5),
})

export async function manufacturingReport(ctx: Ctx, a: z.output<typeof options>) {
  const st = await ctx.kernel.board({ drc: true })
  if (!st || !ctx.doc.pcb) throw new Error('the project has no board yet; start with set_board')
  const build = await ctx.kernel.build()
  const checks = await ctx.kernel.checks()
  const failures = build.features.filter((f) => !f.ok).map((f) => f.name)
  const failedChecks = checks.filter((c) => !c.ok).map((c) => c.name)
  const unverified = ctx.doc.pcb.components.filter((c) => !c.model && !c.footprint.model).map((c) => c.ref)
  const xs = st.board.outline.map((p) => p.x), ys = st.board.outline.map((p) => p.y)
  return {
    format: 'ket-manufacturing', version: 1,
    manufacturer: a.manufacturer, quantity: a.quantity, units: 'mm',
    board: { layers: st.board.layers, thickness: st.board.thickness, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    electrically_ready: !st.board.errors.length && !st.drc?.length && !st.ratsnest.unrouted.length,
    model_checks_pass: build.ok && !failedChecks.length,
    drc_violations: st.drc ?? [], unrouted: st.ratsnest.unrouted,
    board_errors: st.board.errors, failed_features: failures, failed_checks: failedChecks,
    parts_without_3d_model: unverified,
    // A clean algorithmic check is not a physical fit or DFM certification.
    physical_fit_verified: false,
    assembly_csv_format: 'JLCPCB BOM/CPL; review column mapping and rotations with other manufacturers',
    quote_url: MANUFACTURERS[a.manufacturer].quote,
    api_documentation: MANUFACTURERS[a.manufacturer].api,
    submission: 'manual_upload', order_submitted: false,
    warnings: [
      'Prototype package: inspect Gerbers in the manufacturer viewer before ordering.',
      'Electrical DRC and model checks do not verify physical actuator travel, component tolerances, RF keepouts, or manufacturability.',
      'Review stackup, copper weight, finish, mask, panelisation and assembly rotations with the manufacturer.',
      ...(unverified.length ? [`No real 3D model for ${unverified.join(', ')}; enclosure clearance uses proxy geometry.`] : []),
      'No upload, quote request, order or payment was sent. Direct API integration requires an approved manufacturer account and server-side credentials.',
    ],
  }
}

define({
  name: 'manufacturing_quote', group: 'pcb', kind: 'query',
  description: 'Check a board for manufacturer handoff: current DRC, unrouted nets, CAD checks, board dimensions, parts without real 3D models, and the official quote/API links for JLCPCB or PCBWay. Local preflight only: does not upload files, fetch a price, create an order or pay. Use export_manufacturing for the ZIP.',
  args: options,
  run: manufacturingReport,
})

define({
  name: 'export_manufacturing', group: 'pcb', kind: 'query',
  description: 'Download a prototype manufacturer handoff ZIP: Gerbers, drill, JLCPCB-style BOM/CPL, a machine-readable preflight/specification and ordering instructions. JLCPCB or PCBWay. Blocks on DRC, unrouted nets, failed geometry or failed checks; no force bypass. Does not upload/order/pay. Actual component fit and assembly rotations still need human review.',
  args: options.extend({ filename: z.string().optional() }),
  async run(ctx, a) {
    const report = await manufacturingReport(ctx, a)
    if (!report.electrically_ready || !report.model_checks_pass) throw new Error(`manufacturing package blocked: ${report.drc_violations.length} DRC violations, ${report.unrouted.length} unrouted connections, ${report.failed_features.length} failed features, ${report.failed_checks.length} failed checks; fix these before exporting`)
    if (!ctx.download) throw new Error('manufacturing export requires an open Ket browser tab')
    const st = (await ctx.kernel.board())!
    const files = fabFiles(ctx.doc.pcb!, st.board, st.zones)
    files['manufacturing.json'] = JSON.stringify(report, null, 2) + '\n'
    files['ORDERING.md'] = `# ${MANUFACTURERS[a.manufacturer].name} prototype handoff\n\nQuantity requested: ${a.quantity}\nLayers: ${report.board.layers}\nThickness: ${report.board.thickness} mm\nBounding dimensions: ${report.board.width.toFixed(2)} x ${report.board.height.toFixed(2)} mm\n\n1. Open ${report.quote_url}\n2. Upload the Gerber/drill files and inspect all layers and drill holes in the manufacturer's viewer.\n3. Confirm the board settings above; choose copper weight, finish, solder mask and other fabrication options yourself.\n4. For assembly, upload BOM/CPL separately and verify part substitutions, side and rotation. These CSVs use JLCPCB column conventions.\n5. Resolve the warnings below and obtain physical fit/DFM approval before payment.\n\n${report.warnings.map((w) => `- ${w}`).join('\n')}\n\nAPI integration: ${report.api_documentation}\n`
    const { zip } = await import('./zip')
    const blob = zip(files)
    const file = a.filename ?? `board-${a.manufacturer}-prototype.zip`
    await ctx.download(file, blob)
    return { ok: true, file, bytes: blob.size, files: Object.keys(files), report }
  },
})
