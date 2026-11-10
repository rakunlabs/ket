import { expect, it } from 'vitest'
import { applyOp, emptyDoc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { meshTransfer } from '../src/engine/mesh-transfer'
import './setup'

it('can transfer repeated cached builds without detaching any cached mesh attribute', () => {
  const doc = applyOp(emptyDoc(), { cmd: 'box', args: { name: 'case', size: [20, 15, 10] } }).doc
  const kernel = new Kernel()
  const cached = kernel.meshes(kernel.build(doc))[0]
  const keys = ['vertices', 'normals', 'triangles', 'edges', 'edgeGroups', 'faceGroups'] as const
  const originals = keys.map((key) => Array.from(cached[key]))
  for (let i = 0; i < 3; i++) {
    const { meshes, transfer } = meshTransfer(kernel.meshes(kernel.build(doc)))
    const received = structuredClone(meshes, { transfer })
    for (const [index, key] of keys.entries()) {
      expect(meshes[0][key].byteLength).toBe(0)
      expect(Array.from(received[0][key])).toEqual(originals[index])
      expect(Array.from(cached[key])).toEqual(originals[index])
    }
  }
}, 120_000)
