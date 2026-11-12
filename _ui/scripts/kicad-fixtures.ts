// Writes example boards as .kicad_pcb files for an independent check with
// kicad-cli (CI job "kicad"): `pnpm exec tsx scripts/kicad-fixtures.ts <dir>`.
// The boards come from the same commands an agent would run.

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { writeKicadPcb } from '../src/engine/pcb/kicad'
import { setupNode } from '../tests/setup-node'

await setupNode()

const out = resolve(process.argv[2] ?? 'kicad-fixtures')
mkdirSync(out, { recursive: true })

async function run(doc: Doc, k: Kernel, cmd: string, args: unknown): Promise<Doc> {
  const def = command(cmd)!
  let a = parseArgs(def, args)
  if (def.prepare) a = await def.prepare({ doc, kernel: localKernel(k, doc) }, a as never)
  return applyOp(doc, { cmd, args: a }).doc
}

const k = new Kernel()
let doc = emptyDoc()
doc = await run(doc, k, 'set_board', { outline: { rect: { w: 40, h: 30, r: 2 } } })
doc = await run(doc, k, 'add_component', { footprint_name: 'soic8', ref: 'U1', at: [-6, 3], rotation: 30, pin_names: { 1: 'VCC', 8: 'GND' } })
doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R1', at: [8, -4], rotation: 90, side: 'bottom' })
doc = await run(doc, k, 'add_component', { footprint_name: 'pinrow4', ref: 'J1', at: [10, 8] })
doc = await run(doc, k, 'connect', { nets: [{ name: 'VCC', pins: ['U1.1', 'J1.1'] }, { name: 'GND', pins: ['U1.8', 'J1.2', 'R1.2'] }] })
doc = await run(doc, k, 'add_keepout', { name: 'antenna', rect: { at: [-14, -10], w: 8, h: 6 }, forbid: ['tracks', 'pours'] })
doc = await run(doc, k, 'add_mounting_hole', { holes: [{ at: [17, 12], d: 3.2 }] })
k.build(doc)
doc = await run(doc, k, 'autoroute', { timeout: 60 })
doc = await run(doc, k, 'add_zone', { net: 'GND', layer: 'B.Cu' })
k.build(doc)
const st1 = k.boardState(doc)!
const r = writeKicadPcb(doc, st1.board, st1.zones)
writeFileSync(resolve(out, 'example.kicad_pcb'), r.text)
console.log(`wrote ${resolve(out, 'example.kicad_pcb')}`, r.counts)

// 6 layers with a stackup, a blind and a buried via, an inner pour.
const k6 = new Kernel()
const run6 = (d: Doc, cmd: string, args: unknown) => run(d, k6, cmd, args)
let six = emptyDoc()
six = await run6(six, 'set_board', { outline: { rect: { w: 30, h: 20 } }, layers: 6 })
six = await run6(six, 'set_stackup', { preset: 'jlcpcb-6l-3313' })
six = await run6(six, 'add_component', { footprint_name: 'pinrow2', ref: 'J1', at: [-8, 0], rotation: 90 })
six = await run6(six, 'add_component', { footprint_name: 'pinrow2', ref: 'J2', at: [8, 0], rotation: 90 })
six = await run6(six, 'connect', { nets: [{ name: 'A', pins: ['J1.1', 'J2.1'] }, { name: 'GND', pins: ['J1.2', 'J2.2'] }] })
six = await run6(six, 'add_zone', { net: 'GND', layer: 'In4.Cu' })
k6.build(six)
const b6 = k6.boardState(six)!.board
const p1 = b6.pads.find((p) => p.ref === 'J1' && p.pin === '1')!.center
const p2 = b6.pads.find((p) => p.ref === 'J2' && p.pin === '1')!.center
six = await run6(six, 'add_track', { net: 'A', layer: 'F.Cu', points: [[p1.x, p1.y], [-2, p1.y]] })
six = await run6(six, 'add_via', { net: 'A', at: [-2, p1.y], span: ['F.Cu', 'In2.Cu'] })
six = await run6(six, 'add_track', { net: 'A', layer: 'In2.Cu', points: [[-2, p1.y], [2, p1.y]] })
six = await run6(six, 'add_via', { net: 'A', at: [2, p1.y], span: ['In2.Cu', 'In3.Cu'] })
six = await run6(six, 'add_track', { net: 'A', layer: 'In3.Cu', points: [[2, p1.y], [p2.x, p2.y]] })
k6.build(six)
const st6 = k6.boardState(six)!
const r6 = writeKicadPcb(six, st6.board, st6.zones)
writeFileSync(resolve(out, 'six-layer.kicad_pcb'), r6.text)
console.log(`wrote ${resolve(out, 'six-layer.kicad_pcb')}`, r6.counts)
