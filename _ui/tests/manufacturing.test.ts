import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Ctx } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import './setup'

describe('manufacturer handoff', () => {
  it('exports a checked prototype with explicit manual upload and honest readiness', async () => {
    let doc = applyOp(emptyDoc(), { cmd: 'set_board', args: { outline: { rect: { w: 30, h: 20 } } } }).doc
    doc = applyOp(doc, { cmd: 'set_board_style', args: { mask: 'purple', silk: 'white' } }).doc
    const downloads: { name: string; blob: Blob }[] = []
    const ctx: Ctx = { doc, kernel: localKernel(new Kernel(), doc), download: async (name, blob) => { downloads.push({ name, blob }); return name } }
    const def = command('export_manufacturing')!
    const result = await def.run!(ctx, parseArgs(def, { manufacturer: 'pcbway', quantity: 10 }) as never) as any
    expect(result.report.electrically_ready).toBe(true)
    expect(result.report.physical_fit_verified).toBe(false)
    expect(result.report.order_submitted).toBe(false)
    expect(result.report.quantity).toBe(10)
    expect(result.report.board.solder_mask).toBe('purple')
    expect(result.report.board.silkscreen).toBe('white')
    expect(result.files).toContain('manufacturing.json')
    expect(result.files).toContain('ORDERING.md')
    expect(downloads[0].name).toBe('board-pcbway-prototype.zip')
    expect(downloads[0].blob.size).toBeGreaterThan(100)
  })
  it('blocks failed checks without a force bypass', async () => {
    let doc = applyOp(emptyDoc(), { cmd: 'set_board', args: {} }).doc
    doc = applyOp(doc, { cmd: 'set_checks', args: { checks: [{ name: 'fail', kind: 'expr', expr: 'false' }] } }).doc
    const def = command('export_manufacturing')!
    const ctx: Ctx = { doc, kernel: localKernel(new Kernel(), doc), download: async () => { throw new Error('must not download') } }
    await expect(def.run!(ctx, parseArgs(def, {}) as never)).rejects.toThrow(/1 failed checks/)
  })
})
