import { describe, expect, it } from 'vitest'

import { emptyDoc, type Component, type Doc } from '../src/engine/doc'
import { emptyPcb, resolveBoard } from '../src/engine/pcb/board'
import { drc } from '../src/engine/pcb/drc'
import { fabFiles } from '../src/engine/pcb/fab'
import { worldPads } from '../src/engine/pcb/geometry'
import { boardDrills } from '../src/engine/pcb/drills'
import { Kernel } from '../src/engine/kernel'

import './setup'

function doc(): Doc { return { ...emptyDoc(), pcb: emptyPcb() } }
const resolve = (d: Doc) => resolveBoard(d, new Map(), () => { throw new Error('not a sketch') })
const rules = (d: Doc) => drc(d.pcb!, resolve(d))

describe('production geometry guardrails', () => {
  it('rejects off-board vias, width-overhanging tracks and insufficient edge clearance', () => {
    const d = doc()
    d.pcb!.vias.push({ net: 'N', at: [100, 100], diameter: 0.6, drill: 0.3 })
    d.pcb!.tracks.push({ net: 'N', layer: 'F.Cu', width: 0.25, points: [[-10, 14.95], [10, 14.95]] })
    expect(rules(d).filter((v) => v.rule === 'outside_board').map((v) => v.objects?.[0])).toEqual(expect.arrayContaining(['via 1', 'track 1']))
    d.pcb!.vias[0].at = [24.5, 0]
    expect(rules(d).some((v) => v.rule === 'copper_to_edge' && v.objects?.includes('via 1') && v.required === 0.3)).toBe(true)
  })

  it('rejects a track crossing a cutout even if both endpoints are on the board', () => {
    const d = doc(), b = resolve(d)
    b.cutouts = [[{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }]]
    d.pcb!.tracks.push({ net: 'N', layer: 'F.Cu', width: 0.25, points: [[-5, 0], [5, 0]] })
    expect(drc(d.pcb!, b).some((v) => v.rule === 'outside_board')).toBe(true)
  })

  it('rejects a pour outside the board and a pour too close to foreign copper', () => {
    const d = doc(), b = resolve(d)
    d.pcb!.tracks.push({ net: 'OTHER', layer: 'F.Cu', width: 0.25, points: [[-2, 0], [2, 0]] })
    const zones = [{ index: 0, net: 'GND', layer: 'F.Cu', area: 100, dropped: 0, regions: [[[{ x: -30, y: -3 }, { x: 30, y: -3 }, { x: 30, y: 3 }, { x: -30, y: 3 }]]] }]
    const result = drc(d.pcb!, b, zones)
    expect(result.some((v) => v.rule === 'copper_to_edge' && v.objects?.includes('zone 1'))).toBe(true)
    expect(result.some((v) => v.rule === 'clearance' && v.objects?.includes('track 1'))).toBe(true)
  })

  it('preserves slot orientation and plating through geometry, CAD and Excellon', () => {
    const d = doc()
    const component: Component = {
      ref: 'J1', lcsc: '', at: [3, 4], rotation: 90, side: 'bottom', dnp: true,
      footprint: { name: 'slot', pins: { '1': 'SHIELD' }, silk: [], courtyard: [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }], pads: [{ number: '1', shape: 'oval', at: { x: 0, y: 0 }, rotation: 0, w: 4, h: 2, layer: 'through', drill: { d: 1, slot: 3, plated: false } }] },
    }
    d.pcb!.components.push(component)
    const pad = worldPads({ ...component, at: { x: 3, y: 4 }, rotation: 90, side: 'bottom' }, 2)[0]
    expect(pad.drillPlated).toBe(false)
    expect(pad.drillSlot![0].x).toBeCloseTo(3)
    expect(pad.drillSlot![0].y).toBeCloseTo(5)
    expect(pad.drillSlot![1].y).toBeCloseTo(3)
    const b = resolve(d), files = fabFiles(d.pcb!, b)
    expect(files['board-NPTH.drl']).toContain('X3.0000Y5.0000G85X3.0000Y3.0000')
    expect(files['board-PTH.drl']).not.toContain('G85')
    expect(boardDrills(d.pcb!, b)[0].plated).toBe(false)
    const kernel = new Kernel(), build = kernel.build(d)
    const board = build.features.find((f) => f.name === 'board')!
    expect(board.ok).toBe(true)
    // The slot removes (2*1 + π*0.5²)*thickness, not just a round hole.
    expect(board.volume!).toBeCloseTo((50 * 30 - 2 - Math.PI / 4) * 1.6, 2)
  })
})
