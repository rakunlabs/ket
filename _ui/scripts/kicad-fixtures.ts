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
const r = writeKicadPcb(doc, k.boardState(doc)!.board)
writeFileSync(resolve(out, 'example.kicad_pcb'), r.text)
console.log(`wrote ${resolve(out, 'example.kicad_pcb')}`, r.counts)
