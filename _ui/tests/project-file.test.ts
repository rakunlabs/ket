import { describe, expect, it } from 'vitest'

import { applyOp, emptyDoc, type Op } from '../src/engine'
import { readProjectFile, writeProjectFile } from '../src/engine/project-file'

const ops: Op[] = [
  { cmd: 'set_parameters', args: { parameters: [{ name: 'width', expr: 20 }] } },
  { cmd: 'box', args: { name: 'case_body', size: ['width', 10, 3] } },
  { cmd: 'set_checks', args: { checks: [{ name: 'width_ok', kind: 'expr', expr: 'width >= 10' }] } },
  { cmd: 'set_board', args: { outline: { rect: { w: 16, h: 8 } }, z: 4 } },
]

describe('portable .ket files', () => {
  it('round trips an editable document and keeps parameters and PCB', () => {
    const expected = ops.reduce((doc, op) => applyOp(doc, op).doc, emptyDoc())
    const data = writeProjectFile(ops)
    expect(readProjectFile(data).doc).toEqual(expected)
    expect(readProjectFile(writeProjectFile(readProjectFile(data).ops)).doc).toEqual(expected)
    const restored = applyOp(emptyDoc(), { cmd: 'import_project', args: { data } }).doc
    expect(restored).toEqual(expected)
    expect(applyOp(restored, { cmd: 'set_parameters', args: { parameters: [{ name: 'width', expr: 25 }] } }).doc.parameters[0].expr).toBe(25)
  })
  it('refuses nonempty replacement unless explicitly allowed, and fails atomically', () => {
    const existing = applyOp(emptyDoc(), ops[1]).doc
    const data = writeProjectFile(ops)
    expect(() => applyOp(existing, { cmd: 'import_project', args: { data } })).toThrow(/not empty/)
    expect(applyOp(existing, { cmd: 'import_project', args: { data, replace: true } }).doc).toEqual(readProjectFile(data).doc)
    expect(existing.features).toHaveLength(1)
    expect(() => readProjectFile(JSON.stringify({ format: 'ket-project', version: 1, units: 'mm', ops: [ops[0], { cmd: 'box', args: {} }] }))).toThrow(/operation 2/)
    expect(existing.features).toHaveLength(1)
  })
  it('rejects invalid, future and query-containing archives', () => {
    expect(() => readProjectFile('{oops')).toThrow(/not a JSON/)
    expect(() => readProjectFile(JSON.stringify({ format: 'ket-project', version: 2, units: 'mm', ops }))).toThrow(/unsupported/)
    expect(() => writeProjectFile([{ cmd: 'render', args: {} }])).toThrow(/not a supported project mutation/)
    expect(() => writeProjectFile([{ cmd: 'batch', args: { steps: [{ cmd: 'import_project', args: { data: '{}' } }] } }])).toThrow(/nested project/)
  })
  it('re-exports imported projects without nesting files or preceding discarded history', () => {
    const data = writeProjectFile(ops)
    const history = [ops[1], { cmd: 'import_project', args: { data, replace: true } }, { cmd: 'set_parameters', args: { parameters: [{ name: 'width', expr: 30 }] } }]
    const reexported = writeProjectFile(history)
    expect(reexported).not.toContain('import_project')
    expect(readProjectFile(reexported).doc.parameters[0].expr).toBe(30)
  })
})
