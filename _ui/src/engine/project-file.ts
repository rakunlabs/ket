// A portable project is a versioned, prepared command log, not a mesh and not
// server records. Parts and router results travel with their operations; remote
// STEP/STL/texture URLs still need the network when first opened elsewhere.
import { z } from 'zod'

import { emptyDoc, type Doc } from './doc'
import { applyOp, command, define, parseArgs, type Op } from './registry'

export const PROJECT_FILE_LIMIT = 25 * 1024 * 1024
const MAX_OPS = 20_000
const fileSchema = z.object({
  format: z.literal('ket-project'),
  version: z.literal(1),
  units: z.literal('mm'),
  ops: z.array(z.object({ cmd: z.string(), args: z.unknown() }).strict()).max(MAX_OPS),
}).strict()

function checkOp(op: Op, budget: { remaining: number }, depth = 0): void {
  if (--budget.remaining < 0) throw new Error('project file has more than 20,000 operations, including batch steps')
  if (depth > 8) throw new Error('project file has batches nested more than 8 levels')
  // Imports are flattened by the writer. Do not allow recursively nested files.
  if (op.cmd === 'import_project') throw new Error('nested project imports are not supported; export the project again first')
  const def = command(op.cmd)
  if (!def || def.kind !== 'mutate') throw new Error(`"${op.cmd}" is not a supported project mutation; update Ket if this file was saved by a newer version`)
  const args = parseArgs(def, op.args)
  if (op.cmd === 'batch') for (const step of (args as { steps: Op[] }).steps) checkOp(step, budget, depth + 1)
}

export function readProjectFile(data: string): { doc: Doc; ops: Op[] } {
  if (new TextEncoder().encode(data).length > PROJECT_FILE_LIMIT) throw new Error('project file is larger than 25 MiB')
  let raw: unknown
  try { raw = JSON.parse(data) } catch { throw new Error('not a JSON .ket project file') }
  const parsed = fileSchema.safeParse(raw)
  if (!parsed.success) throw new Error('unsupported .ket file: expected format "ket-project", version 1, units "mm", and an ops array')
  let doc = emptyDoc()
  const ops: Op[] = []
  const budget = { remaining: MAX_OPS }
  for (const [i, op] of parsed.data.ops.entries()) {
    try {
      checkOp(op, budget)
      const args = parseArgs(command(op.cmd)!, op.args)
      doc = applyOp(doc, { cmd: op.cmd, args }).doc
      ops.push({ cmd: op.cmd, args })
    } catch (e) {
      throw new Error(`project operation ${i + 1} (${op.cmd}): ${(e as Error).message}`)
    }
  }
  return { doc, ops }
}

export function writeProjectFile(operations: Op[]): string {
  let ops: Op[] = []
  for (const op of operations) {
    if (op.cmd === 'import_project') {
      // An import replaces the document, so history preceding it is not needed.
      ops = readProjectFile((op.args as { data: string }).data).ops
    } else ops.push(op)
  }
  const data = JSON.stringify({ format: 'ket-project', version: 1, units: 'mm', ops }, null, 2) + '\n'
  readProjectFile(data) // Refuse a log with skipped/unsupported operations.
  return data
}

define({
  name: 'export_project', group: 'query', kind: 'query',
  description: 'Save an editable .ket project (versioned JSON with prepared operations): parameters, sketches, CAD, PCB, materials, checks and routing. Open it in another empty project with import_project or the Import Ket button. Does not include users, credentials or server IDs. Remote models/textures remain URL references and require network access. Unlike STL/STEP it preserves the editable design.',
  args: z.object({ filename: z.string().optional() }),
  async run(ctx, a) {
    if (!ctx.projectOps || !ctx.download) throw new Error('project export requires an open Ket browser tab')
    const data = writeProjectFile(ctx.projectOps)
    const file = a.filename ?? 'project.ket'
    const blob = new Blob([data], { type: 'application/json' })
    await ctx.download(file, blob)
    return { ok: true, file, bytes: blob.size, format: 'ket-project', version: 1, external_assets: 'Remote models and textures are URL references, not embedded.' }
  },
})

define({
  name: 'import_project', group: 'project', kind: 'mutate',
  description: 'Open the contents of a .ket project file in this project. Atomic, undoable and deterministic; never downloads or routes during replay. Refuses to replace a nonempty design unless replace: true. File is JSON format ket-project version 1; use export_project to create it. External assets are fetched by the normal build pipeline.',
  args: z.object({ data: z.string().max(PROJECT_FILE_LIMIT).describe('The entire JSON text of a .ket project file'), replace: z.boolean().optional().describe('Explicitly replace the current design (default false)') }),
  apply(doc, a) {
    if (!a.replace && JSON.stringify(doc) !== JSON.stringify(emptyDoc())) throw new Error('this project is not empty: open a new project, or use replace: true (undo restores the previous design)')
    const restored = readProjectFile(a.data)
    return { doc: restored.doc, summary: `imported .ket project: ${restored.doc.features.length} features, ${restored.ops.length} operations` }
  },
})
