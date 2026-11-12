// Shared execution boundaries for the browser, agents, imports and tests.
import { emptyDoc, type Doc } from './doc'
import { applyOp, command, parseArgs, type Ctx, type KernelAPI, type Op } from './registry'

export function requireHealthyHistory(ctx: Pick<Ctx, 'recovery'>) {
  if (ctx.recovery) throw new Error(`design recovery required at operation ${ctx.recovery.seq}: ${ctx.recovery.error}; reload with a compatible Ket build or undo to operation ${ctx.recovery.last_good_seq}. Exports are blocked so an incomplete design cannot be manufactured.`)
}

/** Prepare on a scratch document. No operation reaches storage until all steps succeed. */
export async function prepareOperation(ctx: Ctx, op: Op, kernelFor: (doc: Doc) => KernelAPI): Promise<Op> {
  const def = command(op.cmd)
  if (!def || def.kind !== 'mutate') throw new Error(`"${op.cmd}" is not a change command; batches accept mutations only`)
  const args = parseArgs(def, op.args)
  if (op.cmd !== 'batch') return { cmd: op.cmd, args: def.prepare ? await def.prepare(ctx, args as never) : args }
  let doc = ctx.doc
  const prepared: Op[] = []
  for (const [i, step] of (args as { steps: Op[] }).steps.entries()) {
    try {
      if (step.cmd === 'batch') throw new Error('batches cannot be nested')
      const current = { ...ctx, doc, kernel: kernelFor(doc), projectOps: [...(ctx.projectOps ?? []), ...prepared] }
      const next = await prepareOperation(current, step, kernelFor)
      doc = applyOp(doc, next).doc
      prepared.push(next)
    } catch (error) {
      throw new Error(`step ${i + 1} (${step.cmd}) failed, nothing was changed: ${(error as Error).message}`)
    }
  }
  return { cmd: 'batch', args: { steps: prepared } }
}

export interface ReplayFailure {
  seq: number
  cmd: string
  error: string
  last_good_seq: number
}

/** Stop at the first bad op. Never silently construct a different design by skipping it. */
export function replayOperations(operations: { seq: number; op: Op }[], head: number) {
  let doc = emptyDoc(), lastGood = 0
  const summaries: { seq: number; summary: string }[] = []
  let failure: ReplayFailure | undefined
  for (const item of operations) {
    if (item.seq > head) break
    try {
      if (item.seq !== lastGood + 1) throw new Error(`missing operation ${lastGood + 1}; reload the project history`)
      const result = applyOp(doc, item.op)
      doc = result.doc
      lastGood = item.seq
      summaries.push({ seq: item.seq, summary: result.summary })
    } catch (error) {
      failure = { seq: item.seq, cmd: item.op.cmd, error: (error as Error).message, last_good_seq: lastGood }
      break
    }
  }
  if (!failure && lastGood < head) failure = { seq: lastGood + 1, cmd: '(missing)', error: `missing operation ${lastGood + 1}; reload the project history`, last_good_seq: lastGood }
  return { doc, summaries, failure }
}
