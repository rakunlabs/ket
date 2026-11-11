import { readFileSync } from 'node:fs'

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Ctx, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { boardCopper } from '../src/lib/board3d'

import './setup'

const fixture = (c: string) => JSON.parse(readFileSync(new URL(`./fixtures/${c}.json`, import.meta.url), 'utf8'))
const services: Ctx['services'] = { searchParts: async () => [], getPart: async (l) => fixture(l) }

async function run(doc: Doc, k: Kernel, cmd: string, args: unknown): Promise<Doc> {
  const def = command(cmd)!
  let a = parseArgs(def, args)
  if (def.prepare) a = await def.prepare({ doc, kernel: localKernel(k, doc), services }, a as never)
  return applyOp(doc, { cmd, args: a }).doc
}

describe('board in 3D', () => {
  it('puts tracks, pads and vias on the board faces', async () => {
    const k = new Kernel()
    let doc = emptyDoc()
    doc = await run(doc, k, 'set_board', { outline: { rect: { w: 40, h: 25 } } })
    doc = await run(doc, k, 'add_component', { lcsc: 'C6186', at: [5, 0] })
    doc = await run(doc, k, 'connect', { nets: [{ name: 'A', pins: ['U1.1'] }] })
    doc = await run(doc, k, 'add_track', { net: 'A', points: [[-10, 0], [0, 5]] })
    doc = await run(doc, k, 'add_track', { net: 'A', layer: 'B.Cu', points: [[-10, 0], [-10, -8]] })
    doc = await run(doc, k, 'add_via', { net: 'A', at: [-10, 0] })
    k.build(doc)
    const g = boardCopper(doc.pcb!, k.boardState(doc)!)
    const boxes: { min: number; max: number }[] = []
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const b = new THREE.Box3().setFromObject(o)
        boxes.push({ min: b.min.z, max: b.max.z })
      }
    })
    // Something on the top face (1.6) and something under the bottom face (0).
    expect(boxes.some((b) => b.min >= 1.6 && b.max < 1.75)).toBe(true)
    expect(boxes.some((b) => b.max <= 0 && b.min > -0.15)).toBe(true)
    // The via barrel runs through the board.
    expect(boxes.some((b) => b.min < 0 && b.max > 1.6)).toBe(true)
  }, 60_000)
})
