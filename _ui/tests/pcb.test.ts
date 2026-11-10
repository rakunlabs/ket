import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Ctx, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { fabFiles } from '../src/engine/pcb/fab'
import { exportDSN, importSES } from '../src/engine/pcb/specctra'

import './setup'

const fixture = (c: string) => JSON.parse(readFileSync(new URL(`./fixtures/${c}.json`, import.meta.url), 'utf8'))

const services: Ctx['services'] = {
  searchParts: async () => [],
  getPart: async (lcsc) => fixture(lcsc),
  route: async () => {
    throw new Error('no router in tests')
  },
}

async function run(doc: Doc, k: Kernel, cmd: string, args: unknown): Promise<Doc> {
  const def = command(cmd)!
  let a = parseArgs(def, args)
  if (def.prepare) a = await def.prepare({ doc, kernel: localKernel(k, doc), services }, a as never)
  return applyOp(doc, { cmd, args: a }).doc
}

async function query(doc: Doc, k: Kernel, cmd: string, args: unknown = {}): Promise<any> {
  const def = command(cmd)!
  return def.run!({ doc, kernel: localKernel(k, doc), services }, parseArgs(def, args) as never)
}

describe('pcb', () => {
  it('builds a USB-C → 3.3 V board from real parts', async () => {
    const k = new Kernel()
    let doc = emptyDoc()
    doc = await run(doc, k, 'set_parameters', { parameters: [{ name: 'board_w', expr: 40 }, { name: 'board_h', expr: 25 }] })
    doc = await run(doc, k, 'set_board', { outline: { rect: { w: 'board_w', h: 'board_h', r: 1 } } })
    doc = await run(doc, k, 'add_component', { lcsc: 'C165948', ref: 'J1', at: ['-board_w/2 + 4', 0], rotation: 270 })
    doc = await run(doc, k, 'add_component', { lcsc: 'C6186', at: [5, 0], value: 'AMS1117-3.3' })
    doc = await run(doc, k, 'add_component', { lcsc: 'C25804', at: [14, 6], value: '10k' })
    const refs = doc.pcb!.components.map((c) => c.ref)
    expect(refs).toEqual(['J1', 'U1', 'R1'])
    expect(doc.pcb!.components[1].footprint.pins['3']).toBe('VIN')

    doc = await run(doc, k, 'set_net_class', { name: 'power', track: 0.5 })
    doc = await run(doc, k, 'connect', {
      nets: [
        { name: 'VBUS', pins: ['J1.VBUS', 'U1.VIN'], class: 'power' },
        { name: 'GND', pins: ['J1.GND', 'U1.GND', 'R1.2'], class: 'power' },
        { name: '3V3', pins: ['U1.VOUT', 'R1.1'] },
      ],
    })
    const gnd = doc.pcb!.nets.find((n) => n.name === 'GND')!
    // J1.GND is two pads (A1B12, B1A12).
    expect(gnd.pins).toEqual(['J1.A1B12', 'J1.B1A12', 'U1.1', 'R1.2'])
    const v3 = doc.pcb!.nets.find((n) => n.name === '3V3')!
    expect(v3.pins).toEqual(['U1.2', 'U1.4', 'R1.1'])

    await expect(run(doc, k, 'connect', { nets: [{ name: 'X', pins: ['U1.FOO'] }] })).rejects.toThrow(/no pin "FOO"; pins are: 1=GND, 2=VOUT, 3=VIN, 4=VOUT/)

    k.build(doc)
    const board = await query(doc, k, 'get_board')
    expect(board.components).toHaveLength(3)
    expect(board.routing.routed).toBe('0/3 nets')
    expect(board.routing.missing.length).toBeGreaterThan(0)

    const drc = await query(doc, k, 'run_drc')
    expect(drc.ok).toBe(false)
    expect(drc.unrouted.length).toBeGreaterThan(0)

    // Overlap is caught with names.
    const bad = await run(doc, k, 'move_component', { moves: [{ ref: 'R1', at: [5, 0] }] })
    k.build(bad)
    const drc2 = await query(bad, k, 'run_drc')
    expect(drc2.violations.some((v: { rule: string; message: string }) => v.rule === 'courtyard_overlap' && /U1 and R1/.test(v.message))).toBe(true)

    // Off the board.
    const off = await run(doc, k, 'move_component', { moves: [{ ref: 'R1', at: [30, 0] }] })
    k.build(off)
    expect((await query(off, k, 'run_drc')).by_rule.outside_board).toBeGreaterThan(0)

    // 3D: the board and part blocks are bodies.
    const build = k.build(doc)
    expect(build.bodies).toEqual(expect.arrayContaining(['board', 'part_J1', 'part_U1', 'part_R1']))
    const boardBody = build.features.find((f) => f.name === 'board')!
    expect(boardBody.bbox).toEqual([[-20, -12.5, 0], [20, 12.5, 1.6]])

    // A hand-routed 3V3 connection becomes routed.
    const st = k.boardState(doc)!
    const u2 = st.board.pads.find((p) => p.ref === 'U1' && p.pin === '2')!
    const r1 = st.board.pads.find((p) => p.ref === 'R1' && p.pin === '1')!
    const u4 = st.board.pads.find((p) => p.ref === 'U1' && p.pin === '4')!
    doc = await run(doc, k, 'add_track', { net: '3V3', points: [[u2.center.x, u2.center.y], [r1.center.x, u2.center.y], [r1.center.x, r1.center.y]] })
    doc = await run(doc, k, 'add_track', { net: '3V3', points: [[u4.center.x, u4.center.y], [u4.center.x, -4], [u2.center.x, -4], [u2.center.x, u2.center.y]] })
    k.build(doc)
    const after = await query(doc, k, 'get_board')
    expect(after.nets.find((n: { name: string }) => n.name === '3V3').routed).toBe(true)

    // DSN lists the nets and parts; SES import reads wires back.
    const dsn = exportDSN(doc.pcb!, k.boardState(doc)!.board)
    expect(dsn).toContain('(net VBUS (pins J1-A4B9 J1-B4A9 U1-3))')
    expect(dsn).toContain('(place J1 -16000 0 front 270)')
    const ses = `(session board (routes (resolution um 10) (network_out (net VBUS (wire (path F.Cu 5000 -160000 0 50000 0)) (via V_300_600 50000 0)))))`
    const imported = importSES(ses, new Set(['VBUS']))
    expect(imported.tracks[0]).toEqual({ net: 'VBUS', layer: 'F.Cu', width: 0.5, points: [[-16, 0], [5, 0]] })
    expect(imported.vias[0]).toEqual({ net: 'VBUS', at: [5, 0], drill: 0.3, diameter: 0.6 })

    const files = fabFiles(doc.pcb!, k.boardState(doc)!.board)
    expect(Object.keys(files).sort()).toEqual(
      ['board-B_Cu.gbl', 'board-B_Mask.gbs', 'board-B_Silkscreen.gbo', 'board-Edge_Cuts.gm1', 'board-F_Cu.gtl', 'board-F_Mask.gts', 'board-F_Silkscreen.gto', 'board.drl', 'bom.csv', 'cpl.csv'].sort(),
    )
    expect(files['board-F_Cu.gtl']).toMatch(/%FSLAX46Y46\*%[\s\S]*G36\*[\s\S]*M02\*/)
    expect(files['bom.csv']).toContain('"AMS1117-3.3","U1"')
    expect(files['cpl.csv']).toContain('"J1","-16.000mm","0.000mm","Top","270.0"')
  }, 60_000)

  it('pours copper that keeps clearance and connects its net', async () => {
    const k = new Kernel()
    let doc = emptyDoc()
    doc = await run(doc, k, 'set_board', { outline: { rect: { w: 40, h: 26 } } })
    doc = await run(doc, k, 'add_component', { lcsc: 'C6186', ref: 'U1', at: [0, 0] })
    doc = await run(doc, k, 'add_component', { lcsc: 'C25804', ref: 'R1', at: [12, 6] })
    doc = await run(doc, k, 'add_component', { lcsc: 'C25804', ref: 'R2', at: [-12, -6] })
    doc = await run(doc, k, 'connect', {
      nets: [
        { name: 'GND', pins: ['U1.GND', 'R1.2', 'R2.2'] },
        { name: '3V3', pins: ['U1.VOUT', 'R1.1'] },
      ],
    })
    k.build(doc)
    expect((await query(doc, k, 'get_board')).routing.routed).toBe('0/2 nets')

    doc = await run(doc, k, 'add_zone', { net: 'GND', layer: 'F.Cu' })
    k.build(doc)
    const board = await query(doc, k, 'get_board')
    expect(board.zones).toHaveLength(1)
    expect(board.zones[0].area).toBeGreaterThan(700)
    // The pour ties all GND pads together; 3V3 is still open.
    expect(board.nets.find((n: { name: string }) => n.name === 'GND').routed).toBe(true)
    expect(board.nets.find((n: { name: string }) => n.name === '3V3').routed).toBe(false)

    const drc = await query(doc, k, 'run_drc')
    expect(drc.by_rule.short ?? 0).toBe(0)
    expect(drc.by_rule.clearance ?? 0).toBe(0)

    // The fill stays clear of other nets' pads.
    const st = k.boardState(doc)!
    const { overlaps, offset } = await import('../src/engine/pcb/poly')
    for (const p of st.board.pads.filter((x) => x.net !== 'GND')) {
      for (const reg of st.zones[0].regions) expect(overlaps(reg, offset([p.outline], 0.19))).toBe(false)
    }

    const files = fabFiles(doc.pcb!, st.board, st.zones)
    expect(files['board-F_Cu.gtl']).toContain('%LPC*%')

    doc = await run(doc, k, 'remove_zones', { net: 'GND' })
    expect(doc.pcb!.zones).toEqual([])
    await expect(run(doc, k, 'add_zone', { net: 'NOPE', layer: 'F.Cu' })).rejects.toThrow(/no net "NOPE"/)
  }, 60_000)

  it('exports vendor models to STEP', async () => {
    const k = new Kernel()
    let doc = emptyDoc()
    doc = await run(doc, k, 'set_board', { outline: { rect: { w: 20, h: 15 } } })
    doc = await run(doc, k, 'add_component', { lcsc: 'C6186', ref: 'U1', at: [2, 1], rotation: 90 })
    k.build(doc)
    const blocks = k.export('step', ['part_U1'])
    const obj = readFileSync(new URL('./fixtures/sot223.obj', import.meta.url), 'utf8')
    const detail = k.export('step', ['board', 'part_U1'], { U1: obj })
    expect(detail.size).toBeGreaterThan(blocks.size * 50)
    const text = await detail.text()
    expect(text).toContain('ADVANCED_FACE')
    // The model sits on the board where the part is (x from 2-3.3 to 2+3.3 after the 90° turn).
    const xs = [...text.matchAll(/CARTESIAN_POINT\('',\(([-\d.E+]+),([-\d.E+]+),([-\d.E+]+)\)\)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
    const zs = xs.map((p) => p[2])
    expect(Math.max(...zs)).toBeGreaterThan(2.5)
    expect(Math.max(...zs)).toBeLessThan(4)
  }, 120_000)

  it('keeps schematic wires and splits automatic nets when they go', async () => {
    const { schematic } = await import('../src/engine/pcb/schematic')
    const k = new Kernel()
    let doc = emptyDoc()
    doc = await run(doc, k, 'set_board', { outline: { rect: { w: 30, h: 20 } } })
    for (const [ref, x] of [['R1', -8], ['R2', 0], ['R3', 8]] as const) doc = await run(doc, k, 'add_component', { lcsc: 'C25804', ref, at: [x, 0] })

    // A chain R1.2 — R2.1 — R3.1: one net, two wires, no labels needed.
    doc = await run(doc, k, 'wire_pins', { pins: ['R1.2', 'R2.1', 'R3.1'] })
    expect(doc.pcb!.wires).toHaveLength(2)
    let sch = schematic(doc.pcb!)
    expect(sch.wires).toHaveLength(2)
    expect(sch.symbols.find((s) => s.ref === 'R1')!.labels['2']).toBe(false)
    expect(sch.wires[0].path[0]).toEqual([sch.symbols[0].x + 20, sch.symbols[0].y])

    // Bend points are kept.
    doc = await run(doc, k, 'wire_pins', { pins: ['R1.2', 'R2.1'], points: [[100, 60], [100, 80]] })
    sch = schematic(doc.pcb!)
    const bent = sch.wires.find((w) => w.routed)!.path
    expect(bent).toContainEqual([100, 60])
    expect(bent).toContainEqual([100, 80])
    for (let i = 1; i < bent.length; i++) expect(bent[i][0] === bent[i - 1][0] || bent[i][1] === bent[i - 1][1]).toBe(true)
    // Every wire is orthogonal and leaves its pin outwards.
    for (const w of sch.wires) for (let i = 1; i < w.path.length; i++) expect(w.path[i][0] === w.path[i - 1][0] || w.path[i][1] === w.path[i - 1][1]).toBe(true)

    // Removing the middle wire splits the automatic net in two.
    doc = await run(doc, k, 'remove_wires', { wires: [['R2.1', 'R3.1']] })
    expect(doc.pcb!.nets.map((n) => n.pins.sort())).toEqual([['R1.2', 'R2.1']])
    doc = await run(doc, k, 'wire_pins', { pins: ['R2.2', 'R3.2'], net: 'OUT' })
    doc = await run(doc, k, 'wire_pins', { pins: ['R3.2', 'R1.1'] })
    // On a named net only the drawing goes; labels come back.
    doc = await run(doc, k, 'remove_wires', { wires: [['R1.1', 'R3.2']] })
    expect(doc.pcb!.nets.find((n) => n.name === 'OUT')!.pins).toContain('R1.1')
    expect(schematic(doc.pcb!).symbols.find((s) => s.ref === 'R1')!.labels['1']).toBe(true)

    // Wires follow the netlist: disconnecting a pin drops its wires.
    doc = await run(doc, k, 'disconnect', { pins: ['R2.2'] })
    expect(doc.pcb!.wires!.some((w) => w.a === 'R2.2' || w.b === 'R2.2')).toBe(false)
    await expect(run(doc, k, 'remove_wires', { wires: [['R1.1', 'R3.1']] })).rejects.toThrow(/no wire between/)
  })

  it('prices the BOM and flags stock problems', async () => {
    const k = new Kernel()
    let doc = emptyDoc()
    doc = await run(doc, k, 'set_board', { outline: { rect: { w: 30, h: 20 } } })
    doc = await run(doc, k, 'add_component', { lcsc: 'C6186', ref: 'U1', at: [0, 0] })
    doc = await run(doc, k, 'add_component', { lcsc: 'C25804', ref: 'R1', at: [8, 0] })
    doc = await run(doc, k, 'add_component', { lcsc: 'C25804', ref: 'R2', at: [-8, 0] })
    let asked: Record<string, number> = {}
    const svc = {
      ...services,
      offers: async (parts: Record<string, number>) => {
        asked = parts
        return [
          { lcsc: 'C6186', mpn: 'AMS1117-3.3', basic: false, stock: 8, min: 5, step: 5, unit: 0.12, order: 10, checked: '2026-11-10T00:00:00Z' },
          { lcsc: 'C25804', mpn: '0603WAF1002T5E', basic: true, stock: 100000, min: 100, step: 100, unit: 0.0005, order: 100, checked: '2026-11-10T00:00:00Z' },
        ]
      },
    }
    const def = command('check_bom')!
    const r = (await def.run!({ doc, kernel: localKernel(k, doc), services: svc }, parseArgs(def, { boards: 10 }) as never)) as any
    expect(asked).toEqual({ C6186: 10, C25804: 20 })
    expect(r.totals.extended_parts).toBe(1)
    expect(r.totals.extended_fees_usd).toBe(3)
    expect(r.totals.parts_usd).toBeCloseTo(1.2 + 0.05, 2)
    expect(r.lines.find((l: any) => l.lcsc === 'C25804').order).toBe(100)
    expect(r.problems.join('\n')).toMatch(/only 8 in stock, 10 needed/)
  })

  it('wires pins like a schematic does', async () => {
    const k = new Kernel()
    let doc = emptyDoc()
    doc = await run(doc, k, 'set_board', { outline: { rect: { w: 30, h: 20 } } })
    doc = await run(doc, k, 'add_component', { lcsc: 'C25804', ref: 'R1', at: [-5, 0] })
    doc = await run(doc, k, 'add_component', { lcsc: 'C25804', ref: 'R2', at: [5, 0] })
    doc = await run(doc, k, 'add_component', { lcsc: 'C6186', ref: 'U1', at: [0, 6] })

    doc = await run(doc, k, 'wire_pins', { pins: ['R1.2', 'R2.1'] })
    expect(doc.pcb!.nets).toEqual([{ name: 'N1', pins: ['R1.2', 'R2.1'] }])
    // A loose pin joins the net of the other one.
    doc = await run(doc, k, 'wire_pins', { pins: ['U1.GND', 'R1.1'] })
    doc = await run(doc, k, 'connect', { nets: [{ name: 'GND', pins: ['U1.GND'] }] })
    doc = await run(doc, k, 'add_track', { net: 'N1', layer: 'F.Cu', width: 0.25, points: [[-4, 0], [4, 0]] })
    // Two nets merge; the named one wins and the copper follows.
    doc = await run(doc, k, 'wire_pins', { pins: ['R2.1', 'U1.GND'] })
    const names = doc.pcb!.nets.map((n) => n.name)
    expect(names).toContain('GND')
    expect(names).not.toContain('N1')
    expect(doc.pcb!.tracks[0].net).toBe('GND')

    doc = await run(doc, k, 'rename_net', { from: 'GND', to: 'VSS' })
    expect(doc.pcb!.tracks[0].net).toBe('VSS')
    await expect(run(doc, k, 'rename_net', { from: 'NOPE', to: 'X' })).rejects.toThrow(/no net "NOPE"/)
  })

  it('takes the outline from a sketch and follows its parameters', async () => {
    const k = new Kernel()
    let doc = emptyDoc()
    doc = await run(doc, k, 'set_parameters', { parameters: [{ name: 'w', expr: 30 }] })
    doc = await run(doc, k, 'sketch', { name: 'outline', plane: 'XY' })
    doc = await run(doc, k, 'add_to_sketch', { sketch: 'outline', shapes: [{ kind: 'rect', prefix: 'o', w: 'w', h: 20 }, { kind: 'circle', prefix: 'cut', r: 3, center: [8, 0] }] })
    doc = await run(doc, k, 'set_board', { outline: { sketch: 'outline' } })
    let build = k.build(doc)
    expect(build.features.find((f) => f.name === 'board')!.bbox).toEqual([[-15, -10, 0], [15, 10, 1.6]])
    const st = k.boardState(doc)!
    expect(st.board.cutouts).toHaveLength(1)
    doc = await run(doc, k, 'set_parameters', { parameters: [{ name: 'w', expr: 50 }] })
    build = k.build(doc)
    expect(build.features.find((f) => f.name === 'board')!.bbox![1][0]).toBe(25)
  }, 60_000)
})
