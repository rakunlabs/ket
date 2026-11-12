import { describe, expect, it } from 'vitest'

import { type Ctx, type Doc, applyOp, command, emptyDoc, localKernel, parseArgs } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import './setup'

function run(doc: Doc, cmd: string, args: unknown): Doc {
  return applyOp(doc, { cmd, args: parseArgs(command(cmd)!, args) }).doc
}

const kernelFor = (doc: Doc) => localKernel(new Kernel(), doc)
const ctxFor = (doc: Doc): Ctx => ({ doc, kernel: kernelFor(doc), kernelFor })

async function query(doc: Doc, cmd: string, args: unknown = {}): Promise<any> {
  const def = command(cmd)!
  return def.run!(ctxFor(doc), parseArgs(def, args) as never)
}

function base(): Doc {
  let doc = emptyDoc()
  doc = run(doc, 'set_parameters', { parameters: [{ name: 'w', expr: 40 }, { name: 'wall', expr: 2 }, { name: 'inner', expr: 'w - 2*wall' }] })
  doc = run(doc, 'box', { name: 'case', size: ['w', 20, 10] })
  doc = run(doc, 'set_checks', { checks: [{ name: 'fits_in_60', kind: 'expr', expr: 'w <= 60' }] })
  return doc
}

describe('configurations', () => {
  it('build with their values in place of the base parameters', async () => {
    let doc = base()
    doc = run(doc, 'set_configuration', { name: 'large', values: { w: 80 }, note: 'Bigger board' })
    const k = new Kernel()
    expect(k.build(doc).parameters.w).toBe(40)

    doc = run(doc, 'use_configuration', { name: 'large' })
    const b = k.build(doc)
    expect(b.parameters.w).toBe(80)
    // Derived parameters follow.
    expect(b.parameters.inner).toBe(76)
    expect(b.features.find((f) => f.name === 'case')!.bbox).toEqual([[-40, -10, 0], [40, 10, 10]])

    doc = run(doc, 'use_configuration', {})
    expect(new Kernel().build(doc).parameters.w).toBe(40)
  })

  it('merge values, and replace when asked', () => {
    let doc = base()
    doc = run(doc, 'set_configuration', { name: 'v', values: { w: 50 } })
    doc = run(doc, 'set_configuration', { name: 'v', values: { wall: 3 } })
    expect(doc.configurations![0].values).toEqual({ w: 50, wall: 3 })
    doc = run(doc, 'set_configuration', { name: 'v', values: { wall: 1 }, replace: true })
    expect(doc.configurations![0].values).toEqual({ wall: 1 })
  })

  it('only override parameters that exist, and name the problem', () => {
    expect(() => run(base(), 'set_configuration', { name: 'v', values: { depth: 5 } })).toThrow(/no parameter depth.*set_parameters/)
    expect(() => run(base(), 'use_configuration', { name: 'missing' })).toThrow(/no configuration "missing"/)
  })

  it('run_checks verifies every configuration on its own', async () => {
    let doc = base()
    doc = run(doc, 'set_configuration', { name: 'small', values: { w: 30 } })
    doc = run(doc, 'set_configuration', { name: 'huge', values: { w: 100 } })
    const r = await query(doc, 'run_checks', { configurations: 'all' })
    expect(r.ok).toBe(false)
    expect(r.active).toBe('(base parameters)')
    expect(r.configurations.map((c: any) => [c.configuration, c.ok])).toEqual([['small', true], ['huge', false]])
    expect(r.configurations[1].failed_checks[0].name).toBe('fits_in_60')
    // The plain call checks only the active design.
    expect((await query(doc, 'run_checks')).ok).toBe(true)
  }, 60_000)

  it('keep up with deleted parameters and configurations', () => {
    let doc = base()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'spare', expr: 1 }] })
    doc = run(doc, 'set_configuration', { name: 'v', values: { w: 50, spare: 2 } })
    doc = run(doc, 'use_configuration', { name: 'v' })
    doc = run(doc, 'delete_parameters', { names: ['spare'] })
    expect(doc.configurations![0].values).toEqual({ w: 50 })
    doc = run(doc, 'delete_configurations', { names: ['v'] })
    expect(doc.configurations).toBeUndefined()
    expect(doc.configuration).toBeUndefined()
  })

  it('a configuration value that uses a deleted parameter blocks the delete', () => {
    let doc = base()
    doc = run(doc, 'set_parameters', { parameters: [{ name: 'margin', expr: 1 }] })
    doc = run(doc, 'set_configuration', { name: 'v', values: { w: 'margin * 50' } })
    expect(() => run(doc, 'delete_parameters', { names: ['margin'] })).toThrow(/configuration v \(w\) uses margin/)
  })

  it('get_document shows the active configuration and where values come from', async () => {
    let doc = base()
    doc = run(doc, 'set_configuration', { name: 'large', values: { w: 80 } })
    doc = run(doc, 'use_configuration', { name: 'large' })
    const d = await query(doc, 'get_document')
    expect(d.active_configuration).toBe('large')
    expect(d.parameters).toContain('w = 80 (configuration large; base 40)')
  })
})
