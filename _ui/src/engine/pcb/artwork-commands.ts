import { z } from 'zod'

import { normalizeDoc, type Doc } from '../doc'
import { define } from '../registry'
import { expr, ident, vec2 } from '../schema'
import { bitmapRegions, MASK_COLORS, textRegions } from './artwork'

function edit(doc: Doc) {
  if (!doc.pcb) throw new Error('the project has no board yet; start with set_board')
  const next = normalizeDoc(JSON.parse(JSON.stringify(doc)) as Doc)
  return { next, pcb: next.pcb! }
}

const position = {
  at: vec2.describe('Center in board XY, mm'),
  width: expr.describe('Printed width, mm (aspect ratio is preserved)'),
  rotation: expr.optional().describe('Degrees in board XY, default 0'),
  side: z.enum(['top', 'bottom']).default('top').describe('Bottom artwork is automatically mirrored for readable printing'),
}
const point = z.object({ x: z.number().finite(), y: z.number().finite() })
const regions = z.array(z.array(z.array(point).min(3).max(20000)).min(1)).min(1).max(10000)
  .refine((rs) => rs.flat(2).length <= 20000, 'artwork is too complex; simplify it to at most 20,000 polygon vertices')

define({
  name: 'set_board_style', group: 'pcb', kind: 'mutate',
  description: 'Set the PCB solder-mask color and single-color silkscreen ink. Shown in 2D/3D; saved as manufacturing order preferences (Gerber contains ink shapes, not color choices). Verify with get_board or render_board. Match the choices in the manufacturer order form; actual colors and availability vary.',
  args: z.object({ mask: z.enum(Object.keys(MASK_COLORS) as [keyof typeof MASK_COLORS, ...(keyof typeof MASK_COLORS)[]]).optional(), silk: z.enum(['white', 'black']).optional() }),
  apply(doc, a) {
    const { next, pcb } = edit(doc)
    pcb.style = { mask: pcb.style?.mask ?? 'green', silk: pcb.style?.silk ?? 'white', ...a }
    return { doc: next, summary: `board: ${pcb.style.mask} mask, ${pcb.style.silk} silkscreen` }
  },
})

define({
  name: 'add_board_artwork', group: 'pcb', kind: 'mutate',
  description: 'Print centered text or a monochrome logo onto the top/bottom PCB silkscreen, in mm. Give text OR bitmap (rectangular rows of # ink and . empty, at most 256 × 256). Dark image pixels become ink regardless of ink color. Text uses the bundled IBM Plex Mono outline font. Artwork goes into 2D, 3D and Gerber, not copper. Use run_drc to check pad/edge clearance and render_board to inspect. Review fine details with the manufacturer. Prepared polygons are stored for deterministic replay and portable .ket files.',
  args: z.object({ name: ident, ...position, text: z.string().trim().min(1).max(100).optional(), bitmap: z.array(z.string().min(1).max(256)).min(1).max(256).optional(), prepared: regions.optional(), replace: z.boolean().optional() }),
  internal: ['prepared'],
  async prepare(ctx, a) {
    if (!ctx.doc.pcb) throw new Error('the project has no board yet; start with set_board')
    if (!!a.text === !!a.bitmap) throw new Error('provide text or bitmap, not both')
    if (a.prepared) return a
    return { ...a, prepared: regions.parse(a.text ? await textRegions(a.text) : bitmapRegions(a.bitmap!)) }
  },
  apply(doc, a) {
    if (!!a.text === !!a.bitmap) throw new Error('provide text or bitmap, not both')
    if (!a.prepared) throw new Error('artwork is not prepared; run add_board_artwork through prepare before replaying it')
    const { next, pcb } = edit(doc)
    const index = (pcb.artwork ?? []).findIndex((art) => art.name === a.name)
    if (index >= 0 && !a.replace) throw new Error(`artwork "${a.name}" already exists; use replace: true or choose another name`)
    if (index < 0 && (pcb.artwork?.length ?? 0) >= 100) throw new Error('a board supports at most 100 artwork items; remove unused items first')
    const art = { name: a.name, kind: a.text ? 'text' as const : 'image' as const, ...(a.text ? { text: a.text } : {}), at: a.at, width: a.width, rotation: a.rotation, side: a.side, regions: a.prepared }
    pcb.artwork ??= []
    if (index >= 0) pcb.artwork[index] = art
    else pcb.artwork.push(art)
    return { doc: next, summary: `printed ${a.name} on ${a.side} silkscreen` }
  },
})

define({
  name: 'update_board_artwork', group: 'pcb', kind: 'mutate',
  description: 'Move, resize, rotate or flip existing PCB silkscreen artwork. Keeps its prepared text/image outlines. Use add_board_artwork with replace: true to change the text or bitmap. Verify with get_board, render_board and run_drc.',
  args: z.object({ name: ident, at: position.at.optional(), width: position.width.optional(), rotation: expr.optional(), side: z.enum(['top', 'bottom']).optional() }),
  apply(doc, a) {
    const { next, pcb } = edit(doc)
    const art = pcb.artwork?.find((item) => item.name === a.name)
    if (!art) throw new Error(`no board artwork "${a.name}"; use get_board to list it`)
    Object.assign(art, a)
    return { doc: next, summary: `updated board artwork ${a.name}` }
  },
})

define({
  name: 'remove_board_artwork', group: 'pcb', kind: 'mutate',
  description: 'Remove named PCB silkscreen artwork. Undo restores it; verify with get_board.',
  args: z.object({ names: z.array(ident).min(1) }),
  apply(doc, a) {
    const { next, pcb } = edit(doc)
    for (const name of a.names) if (!pcb.artwork?.some((art) => art.name === name)) throw new Error(`no board artwork "${name}"; use get_board to list it`)
    pcb.artwork = pcb.artwork!.filter((art) => !a.names.includes(art.name))
    return { doc: next, summary: `removed ${a.names.length} artwork item(s)` }
  },
})
