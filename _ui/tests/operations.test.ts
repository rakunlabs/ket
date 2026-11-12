import { describe, expect, it } from 'vitest'

import { applyOp, emptyDoc, localKernel, prepareOperation, replayOperations, type Op } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import './setup'

describe('AI operation boundaries', () => {
  it('prepares dependent steps against the preceding scratch document', async () => {
    const doc = emptyDoc(), kernel = new Kernel()
    const kernelFor = (d: typeof doc) => localKernel(kernel, d)
    const op = await prepareOperation({ doc, kernel: kernelFor(doc) }, { cmd: 'batch', args: { steps: [
      { cmd: 'set_board', args: {} },
      { cmd: 'add_component', args: { footprint_name: '0603', at: [0, 0], ref: 'R1' } },
      { cmd: 'add_board_artwork', args: { name: 'logo', bitmap: ['#'], at: [0, 5], width: 2 } },
    ] } }, kernelFor)
    expect(doc.pcb).toBeUndefined()
    const next = applyOp(doc, op).doc
    expect(next.pcb!.components[0].ref).toBe('R1')
    expect(next.pcb!.artwork).toHaveLength(1)
  })

  it('fails atomically on an invalid later step and forbids queries/nested batches', async () => {
    const doc = emptyDoc(), kernelFor = (d: typeof doc) => localKernel(new Kernel(), d), ctx = { doc, kernel: kernelFor(doc) }
    for (const step of [{ cmd: 'get_document', args: {} }, { cmd: 'batch', args: { steps: [{ cmd: 'set_board', args: {} }] } }, { cmd: 'move_component', args: { moves: [{ ref: 'missing', at: [0, 0] }] } }]) {
      await expect(prepareOperation(ctx, { cmd: 'batch', args: { steps: [{ cmd: 'set_board', args: {} }, step] } }, kernelFor)).rejects.toThrow(/step 2.*nothing was changed/)
    }
    expect(doc).toEqual(emptyDoc())
  })

  it('stops at the first replay error instead of silently skipping it', () => {
    const ops: { seq: number; op: Op }[] = [
      { seq: 1, op: { cmd: 'set_board', args: {} } },
      { seq: 2, op: { cmd: 'newer_unknown_command', args: {} } },
      { seq: 3, op: { cmd: 'set_description', args: { description: 'must not replay' } } },
    ]
    const result = replayOperations(ops, 3)
    expect(result.failure).toMatchObject({ seq: 2, last_good_seq: 1 })
    expect(result.doc.meta.description).toBeUndefined()
    expect(result.summaries).toHaveLength(1)
    expect(replayOperations(ops, 1).failure).toBeUndefined()
    expect(replayOperations([ops[0], ops[2]], 3).failure?.error).toContain('missing operation 2')
  })
})
