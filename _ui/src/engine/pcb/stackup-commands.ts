// Stackup and controlled impedance.

import { z } from 'zod'

import { type Stackup, copperLayersOf } from '../doc'
import { define } from '../registry'
import { clone, pcbOf } from './shared'
import { STACKUP_PRESETS, checkStackup, impedance, layerGeometry, stackupThickness, widthFor } from './stackup'

const presetNames = Object.keys(STACKUP_PRESETS) as [string, ...string[]]

define({
  name: 'set_stackup',
  group: 'pcb',
  kind: 'mutate',
  description: `Set the board's physical build-up: copper thickness per layer (µm, 35 = 1 oz) and the dielectric between each pair (thickness mm, εr), top to bottom. Use a preset (${presetNames.join(', ')}; JLCPCB's standard stackups, values as published: check the current ones before ordering) or give copper and dielectric. The board thickness follows the stackup. impedance uses it to size controlled-impedance tracks; export_manufacturing lists it.`,
  args: z.object({
    preset: z.enum(presetNames).optional(),
    copper: z.array(z.number()).optional().describe('µm per copper layer, top to bottom'),
    dielectric: z.array(z.object({ thickness: z.number(), er: z.number(), kind: z.enum(['core', 'prepreg']).optional() })).optional().describe('Between each pair of copper layers, top to bottom'),
    mask: z.object({ thickness: z.number(), er: z.number() }).optional(),
  }),
  examples: [{ preset: 'jlcpcb-4l-7628' }],
  apply(doc, a) {
    const next = clone(doc)
    const pcb = pcbOf(next)
    let s: Stackup
    if (a.preset) {
      const p = STACKUP_PRESETS[a.preset]
      if (p.layers !== pcb.layers) throw new Error(`${a.preset} is a ${p.layers}-layer stackup and the board has ${pcb.layers}; set_board layers: ${p.layers} first, or pick a ${pcb.layers}-layer preset`)
      s = { ...structuredClone(p.stackup), preset: a.preset }
    } else {
      if (!a.copper || !a.dielectric) throw new Error('give a preset, or copper and dielectric')
      s = { copper: a.copper, dielectric: a.dielectric, ...(a.mask ? { mask: a.mask } : {}) }
    }
    const bad = checkStackup(s, pcb.layers)
    if (bad) throw new Error(bad)
    pcb.stackup = s
    pcb.thickness = Math.round(stackupThickness(s) * 1000) / 1000
    return { doc: next, summary: `stackup ${a.preset ?? 'custom'}: ${pcb.layers} layers, ${pcb.thickness} mm` }
  },
})

define({
  name: 'impedance',
  group: 'pcb',
  kind: 'query',
  description:
    'Controlled impedance from the stackup (set_stackup): on a layer, give target Ω to get the track width, or width to get the impedance. Outer layers are microstrip over the next plane, inner layers stripline between their neighbours (assumed solid planes). With gap it is an edge-coupled differential pair (USB 90 Ω, Ethernet 100 Ω). Closed-form IPC-2141 approximations: good for choosing a width; the fab\'s field solver decides, ask them to control it.',
  args: z.object({
    layer: z.string().describe('Copper layer, e.g. F.Cu'),
    target: z.number().positive().optional().describe('Ω; returns the width'),
    width: z.number().positive().optional().describe('mm; returns the impedance'),
    gap: z.number().positive().optional().describe('Pair gap (edge to edge), mm: differential'),
  }),
  async run(ctx, a) {
    const pcb = ctx.doc.pcb
    if (!pcb) throw new Error('the project has no board yet; start with set_board')
    if (!pcb.stackup) throw new Error(`the board has no stackup; set_stackup first (e.g. preset ${presetNames.find((n) => STACKUP_PRESETS[n].layers === pcb.layers) ?? presetNames[0]})`)
    const layers = copperLayersOf(pcb.layers)
    const i = layers.indexOf(a.layer as never)
    if (i < 0) throw new Error(`${a.layer} is not a layer of this board; layers are ${layers.join(', ')}`)
    if (!a.target === !a.width) throw new Error('give target (Ω, for the width) or width (mm, for the impedance)')
    const g = layerGeometry(pcb.stackup, i)
    const diff = a.gap !== undefined
    const geometry = (diff ? `diff_${g.kind}` : g.kind) as Parameters<typeof impedance>[0]['geometry']
    const base = { geometry, t: g.t, h: g.h, er: g.er, s: a.gap }
    const r2 = (v: number) => Math.round(v * 1000) / 1000
    const notes = [
      'IPC-2141 closed form: expect a few percent from a field solver; have the fab control impedance on the order',
      ...(g.asymmetric ? ['the dielectrics above and below this inner layer differ a lot: the symmetric stripline formula is a rough guide here'] : []),
    ]
    if (a.target) {
      const w = widthFor(a.target, base)
      if (w === undefined) throw new Error(`${a.target} Ω is out of reach on ${a.layer} with this stackup (between 0.02 and 10 mm wide)${diff ? '; change the gap' : ''}`)
      if (w < 0.1) notes.push(`${r2(w)} mm is below JLCPCB's 0.1 mm minimum track: use a thinner dielectric (another stackup) or another layer`)
      return { layer: a.layer, geometry, target: a.target, width: r2(w), ...(diff ? { gap: a.gap } : {}), dielectric: { h: r2(g.h), er: r2(g.er) }, copper_um: g.t * 1000, notes }
    }
    const z0 = impedance({ ...base, w: a.width! })
    return { layer: a.layer, geometry, width: a.width, impedance: Math.round(z0 * 10) / 10, ...(diff ? { gap: a.gap } : {}), dielectric: { h: r2(g.h), er: r2(g.er) }, notes }
  },
})
