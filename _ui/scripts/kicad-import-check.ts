// Imports KiCad's own demo boards (from the KiCad Docker image, not kept in
// this repository) and checks that every one opens: the build succeeds, the
// board resolves, and nothing throws. Prints what was not carried over.
//   pnpm exec tsx scripts/kicad-import-check.ts <dir with .kicad_pcb files>

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { applyOp, command, emptyDoc, parseArgs } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { setupNode } from '../tests/setup-node'

await setupNode()
const dir = resolve(process.argv[2] ?? 'kicad-demos')
let failed = 0
for (const f of readdirSync(dir).filter((x) => x.endsWith('.kicad_pcb'))) {
  try {
    const doc = applyOp(emptyDoc(), { cmd: 'import_kicad', args: parseArgs(command('import_kicad')!, { data: readFileSync(resolve(dir, f), 'utf8') }) }).doc
    const k = new Kernel()
    const b = k.build(doc)
    const st = k.boardState(doc, { drc: true })
    if (!st || b.features.some((x) => !x.ok) || st.board.errors.length) throw new Error(`build: ${[...b.features.filter((x) => !x.ok).map((x) => x.error), ...(st?.board.errors ?? [])].join('; ')}`)
    console.log(`ok   ${f}: ${doc.pcb!.components.length} parts, ${doc.pcb!.nets.length} nets, ${st.ratsnest.routed}/${st.ratsnest.total} routed, ${st.drc!.length} DRC findings`)
  } catch (e) {
    failed++
    console.log(`FAIL ${f}: ${(e as Error).message}`)
  }
}
if (failed) process.exit(1)
