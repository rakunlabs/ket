// Footprints from a name, with tscircuit's footprinter (ISC): "0402",
// "0603", "soic8", "sot23", "qfn16_p0.5mm", "pinrow4", "dip8", "to220",
// "jst_ph_4", "tssop20", ... and parameters in the name ("pinrow6_p2mm",
// "soic8_pw0.6mm"). Its circuit JSON (pads, plated holes, silk paths,
// courtyard) becomes a Ket footprint, so a part needs no LCSC library entry
// (generic passives, headers, test points, a part EasyEDA has no footprint for).

import type { Footprint, P, Pad } from '../doc'

type Elem = Record<string, unknown> & { type: string }

const r4 = (v: number) => Math.round(v * 1e4) / 1e4

/** The footprinter's footprint families, for error messages and the tool description. */
export async function footprintNames(): Promise<string[]> {
  const m = await import('@tscircuit/footprinter')
  return m.getFootprintNames()
}

/** A Ket footprint from a footprinter name. Pins are numbered as the footprinter numbers them (1, 2, ...). */
export async function footprintFromName(name: string, pinNames: Record<string, string> = {}): Promise<Footprint> {
  const m = await import('@tscircuit/footprinter')
  // Bare family names that need parameters in the footprinter get defaults.
  const fpName = ({ pad: 'smtpad', smdpad: 'smtpad', testpoint: 'smtpad_circle_d1.5' } as Record<string, string>)[name] ?? name
  let elems: Elem[]
  try {
    elems = (m.fp.string(fpName) as unknown as { circuitJson(): Elem[] }).circuitJson()
  } catch (e) {
    throw new Error(`footprint "${name}": ${(e as Error).message.split('\n')[0]}; families are: ${m.getFootprintNames().slice(0, 60).join(', ')}, ... (e.g. "0603", "soic8", "sot23", "qfn16_p0.5mm", "pinrow4", "dip8")`)
  }
  const pads: Pad[] = []
  const silk: Footprint['silk'] = []
  let courtyard: P[] = []
  const num = (e: Elem, i: number) => {
    const hints = e.port_hints as string[] | undefined
    return hints?.find((h) => /^\d+$/.test(h)) ?? hints?.[0] ?? String(i + 1)
  }
  for (const [i, e] of elems.entries()) {
    const x = Number(e.x ?? 0)
    const y = Number(e.y ?? 0)
    switch (e.type) {
      case 'pcb_smtpad': {
        const shape = e.shape === 'circle' ? 'circle' : 'rect'
        const w = shape === 'circle' ? Number(e.radius) * 2 : Number(e.width)
        const h = shape === 'circle' ? w : Number(e.height)
        pads.push({ number: num(e, i), shape, at: { x: r4(x), y: r4(y) }, rotation: 0, w: r4(w), h: r4(h), layer: e.layer === 'bottom' ? 'bottom' : 'top' })
        break
      }
      case 'pcb_plated_hole': {
        const d = Number(e.hole_diameter ?? e.hole_width ?? 0.8)
        let w = Number(e.outer_diameter ?? e.rect_pad_width ?? e.outer_width ?? d + 0.6)
        let h = Number(e.outer_diameter ?? e.rect_pad_height ?? e.outer_height ?? w)
        const rect = e.shape === 'circular_hole_with_rect_pad' || e.pad_shape === 'rect'
        const pill = e.shape === 'pill' || e.shape === 'oval'
        if (pill) {
          w = Number(e.outer_width ?? w)
          h = Number(e.outer_height ?? h)
        }
        pads.push({
          number: num(e, i),
          shape: rect ? 'rect' : pill ? 'oval' : 'circle',
          at: { x: r4(x), y: r4(y) },
          rotation: 0,
          w: r4(w),
          h: r4(h),
          drill: { d: r4(d), plated: true, ...(pill && Number(e.hole_height ?? 0) > d ? { slot: r4(Number(e.hole_height)) } : {}) },
          layer: 'through',
        })
        break
      }
      case 'pcb_silkscreen_path': {
        const route = (e.route as { x: number; y: number }[]) ?? []
        const w = Number(e.stroke_width ?? 0.12)
        for (let k = 1; k < route.length; k++) silk.push([r4(route[k - 1].x), r4(route[k - 1].y), r4(route[k].x), r4(route[k].y), w])
        break
      }
      case 'pcb_courtyard_rect': {
        const c = e.center as { x: number; y: number }
        const hw = Number(e.width) / 2
        const hh = Number(e.height) / 2
        courtyard = [
          { x: r4(c.x - hw), y: r4(c.y - hh) },
          { x: r4(c.x + hw), y: r4(c.y - hh) },
          { x: r4(c.x + hw), y: r4(c.y + hh) },
          { x: r4(c.x - hw), y: r4(c.y + hh) },
        ]
        break
      }
      case 'pcb_courtyard_outline': {
        // Ket's courtyard is one convex-ish outline for overlap checks: use the bounds.
        const o = (e.outline as { x: number; y: number }[]) ?? []
        if (o.length >= 3) {
          const xs = o.map((p) => p.x)
          const ys = o.map((p) => p.y)
          courtyard = [
            { x: r4(Math.min(...xs)), y: r4(Math.min(...ys)) },
            { x: r4(Math.max(...xs)), y: r4(Math.min(...ys)) },
            { x: r4(Math.max(...xs)), y: r4(Math.max(...ys)) },
            { x: r4(Math.min(...xs)), y: r4(Math.max(...ys)) },
          ]
        }
        break
      }
    }
  }
  if (!pads.length) throw new Error(`footprint "${name}" has no pads`)
  if (!courtyard.length) {
    // Pads plus 0.25 mm.
    const xs = pads.flatMap((p) => [p.at.x - p.w / 2, p.at.x + p.w / 2])
    const ys = pads.flatMap((p) => [p.at.y - p.h / 2, p.at.y + p.h / 2])
    const [x0, x1, y0, y1] = [Math.min(...xs) - 0.25, Math.max(...xs) + 0.25, Math.min(...ys) - 0.25, Math.max(...ys) + 0.25]
    courtyard = [
      { x: r4(x0), y: r4(y0) },
      { x: r4(x1), y: r4(y0) },
      { x: r4(x1), y: r4(y1) },
      { x: r4(x0), y: r4(y1) },
    ]
  }
  const pins: Record<string, string> = {}
  for (const p of pads) pins[p.number] = pinNames[p.number] ?? p.number
  return { name, pads, silk, courtyard, pins }
}
