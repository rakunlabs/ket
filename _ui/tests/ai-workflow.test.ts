import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, prepareOperation, type Ctx, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { electricalCheck } from '../src/engine/pcb/erc'
import './setup'

const kernelFor = (doc: Doc) => localKernel(new Kernel(), doc)
const ctxFor = (doc: Doc): Ctx => ({ doc, kernel: kernelFor(doc), kernelFor, revision: 7 })
const mutate = (doc: Doc, cmd: string, args: unknown) => applyOp(doc, { cmd, args }).doc
async function query(doc: Doc, cmd: string, args: unknown = {}, extra: Partial<Ctx> = {}): Promise<any> {
  const def = command(cmd)!
  return def.run!({ ...ctxFor(doc), ...extra }, parseArgs(def, args) as never)
}
async function circuit() {
  const doc = emptyDoc(), ctx = ctxFor(doc)
  const op = await prepareOperation(ctx, { cmd: 'batch', args: { steps: [
    { cmd: 'set_board', args: {} },
    { cmd: 'add_component', args: { ref: 'U1', footprint_name: 'pinrow2', at: [-8, 0], pin_names: { '1': 'OUT', '2': 'VCC' } } },
    { cmd: 'add_component', args: { ref: 'U2', footprint_name: 'pinrow2', at: [8, 0], pin_names: { '1': 'OUT', '2': 'VCC' } } },
    { cmd: 'connect', args: { nets: [{ name: 'SIGNAL', pins: ['U1.OUT', 'U2.OUT'] }] } },
  ] } }, kernelFor)
  return applyOp(doc, op).doc
}

describe('AI diagnose → preview → repair → verify', () => {
  it('exposes stable problem IDs, evidence, suggested commands and pagination', async () => {
    let doc = mutate(emptyDoc(), 'set_board', {})
    doc.pcb!.vias = [{ net: 'N', at: [100, 100], diameter: 0.6, drill: 0.3 }]
    const report = await query(doc, 'get_problems')
    expect(report.ok).toBe(false)
    const issue = report.problems.find((p: any) => p.rule === 'outside_board')
    expect(issue.objects).toContain('via 1')
    expect(issue.location.at).toEqual([100, 100])
    for (const problem of report.problems) for (const cmd of problem.suggested_commands) expect(command(cmd) || cmd === 'undo').toBeTruthy()
    doc = mutate(doc, 'edit_copper', { vias: [{ number: 1, at: [90, 90] }] })
    expect((await query(doc, 'get_problems')).problems.some((p: any) => p.id === issue.id)).toBe(true)
    const limited = await query(doc, 'get_problems', { domain: 'pcb', limit: 1 })
    expect(limited.problems).toHaveLength(1)
    expect(limited.total).toBeGreaterThanOrEqual(1)
  })

  it('dry-runs a precise copper repair without changing the document or committing', async () => {
    const doc = mutate(emptyDoc(), 'set_board', {})
    doc.pcb!.vias = [{ net: 'N', at: [100, 100], diameter: 0.6, drill: 0.3 }]
    const original = JSON.stringify(doc)
    const result = await query(doc, 'preview_changes', { steps: [{ cmd: 'edit_copper', args: { vias: [{ number: 1, at: [0, 0] }] } }] })
    expect(result.committed).toBe(false)
    expect(result.base_revision).toBe(7)
    expect(result.ok).toBe(true)
    expect(result.resolved.length).toBeGreaterThan(0)
    expect(result.after.errors).toBe(0)
    expect(JSON.stringify(doc)).toBe(original)
  })

  it('preserves net identity and uses original indices for atomic edits/removals', async () => {
    let doc = mutate(emptyDoc(), 'set_board', {})
    doc.pcb!.vias = [0, 1, 2].map((x) => ({ net: `N${x}`, at: [x * 3, 0], diameter: 0.6, drill: 0.3 }))
    doc = mutate(doc, 'edit_copper', { vias: [{ number: 3, at: [9, 2] }], remove_vias: [1] })
    expect(doc.pcb!.vias.map((v) => v.net)).toEqual(['N1', 'N2'])
    expect(doc.pcb!.vias[1].at).toEqual([9, 2])
    expect(() => mutate(doc, 'edit_copper', { vias: [{ number: 1, diameter: 0.2 }] })).toThrow(/drill must be smaller/)
    expect(() => mutate(doc, 'edit_copper', { remove_vias: [2, 2] })).toThrow(/duplicated/)
    expect((await query(doc, 'get_copper', { vias: [2] })).objects).toHaveLength(1)
  })

  it('detects explicitly declared electrical conflicts and reports unknown coverage honestly', async () => {
    let doc = await circuit()
    expect(electricalCheck(doc.pcb!).coverage.unknown).toBe(4)
    doc = mutate(doc, 'set_pin_rules', { rules: [{ pin: 'U1.OUT', type: 'output' }, { pin: 'U2.OUT', type: 'output' }, { pin: 'U1.VCC', type: 'power_in', required: true }, { pin: 'U2.VCC', type: 'no_connect' }] })
    const erc = await query(doc, 'run_erc')
    expect(erc.ok).toBe(false)
    expect(erc.coverage).toEqual({ typed: 4, total: 4, unknown: 0 })
    expect(erc.issues.some((p: any) => p.rule === 'output_conflict')).toBe(true)
    expect(erc.issues.some((p: any) => p.rule === 'required_pin_unconnected')).toBe(true)
    expect((await query(doc, 'get_problems', { domain: 'electrical' })).problems.some((p: any) => p.rule === 'output_conflict')).toBe(true)
    doc = mutate(doc, 'set_pin_rules', { rules: [{ pin: 'U2.OUT', type: 'input' }, { pin: 'U1.VCC', type: 'power_in', required: false }] })
    expect((await query(doc, 'run_erc')).ok).toBe(true)
    expect(() => mutate(doc, 'set_pin_rules', { rules: [{ pin: 'U1.OUT', type: 'no_connect', required: true }] })).toThrow(/cannot be required/)
    doc.pcb!.components[0].pin_rules!['removed_pad'] = { type: 'input', required: true }
    expect((await query(doc, 'run_erc')).issues.some((p: any) => p.rule === 'pin_rule_missing_pad')).toBe(true)
    doc = mutate(doc, 'set_pin_rules', { rules: [{ pin: 'U1.removed_pad', type: null }] })
    expect((await query(doc, 'run_erc')).issues.some((p: any) => p.rule === 'pin_rule_missing_pad')).toBe(false)
  })

  it('blocks manufacturing, CAD and project exports on a partial recovered history', async () => {
    const doc = mutate(emptyDoc(), 'set_board', {})
    const recovery = { seq: 2, cmd: 'unknown', error: 'unsupported', last_good_seq: 1 }
    const extra: Partial<Ctx> = { recovery, projectOps: [], download: async () => { throw new Error('must not download') } }
    for (const [cmd, args] of [['export_fab', { force: true }], ['export_manufacturing', {}], ['export', { format: 'step' }], ['export_project', {}], ['preview_changes', { steps: [{ cmd: 'set_board_style', args: { mask: 'black' } }] }]] as const) await expect(query(doc, cmd, args, extra)).rejects.toThrow(/recovery required/)
    expect((await query(doc, 'get_document', {}, extra)).ok).toBe(false)
    expect((await query(doc, 'get_problems', {}, extra)).problems.some((p: any) => p.rule === 'replay_failed')).toBe(true)
  })

  it('focuses a current problem but refuses obsolete IDs', async () => {
    const doc = mutate(emptyDoc(), 'set_board', {})
    doc.pcb!.vias = [{ net: 'N', at: [100, 100], diameter: 0.6, drill: 0.3 }]
    const id = (await query(doc, 'get_problems')).problems[0].id
    let target: unknown
    const result = await query(doc, 'focus_problem', { id }, { focus: (t) => { target = t } })
    expect(result.focused).toBe(true)
    expect(target).toMatchObject({ view: 'pcb', at: [100, 100] })
    await expect(query(doc, 'focus_problem', { id: 'old' })).rejects.toThrow(/no longer exists/)
  })
})
