import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { writeKicadPcb } from '../src/engine/pcb/kicad'
import { parseSexpr, readKicadPcb } from '../src/engine/pcb/kicad-read'
import './setup'

async function run(doc: Doc, k: Kernel, cmd: string, args: unknown): Promise<Doc> {
  const def = command(cmd)!
  let a = parseArgs(def, args)
  if (def.prepare) a = await def.prepare({ doc, kernel: localKernel(k, doc) }, a as never)
  return applyOp(doc, { cmd, args: a }).doc
}

async function source(k: Kernel) {
  let doc = await run(emptyDoc(), k, 'set_board', { outline: { rect: { w: 40, h: 30 } }, layers: 4 })
  doc = await run(doc, k, 'add_component', { footprint_name: 'soic8', ref: 'U1', at: [-6, 3], rotation: 30, pin_names: { 1: 'VCC', 8: 'GND' } })
  doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R1', at: [8, -4], rotation: 70, side: 'bottom', value: '10k' })
  doc = await run(doc, k, 'add_component', { footprint_name: 'sot23', ref: 'Q1', at: [8, 8], rotation: 135, side: 'bottom' })
  doc = await run(doc, k, 'connect', { nets: [{ name: 'VCC', pins: ['U1.1', 'R1.1'] }, { name: 'GND', pins: ['U1.8', 'R1.2', 'Q1.1'] }] })
  doc = await run(doc, k, 'add_track', { net: 'VCC', layer: 'In1.Cu', points: [[0, 0], [5, 5], [10, 5]] })
  doc = await run(doc, k, 'add_via', { net: 'GND', at: [2, -8], span: ['F.Cu', 'In1.Cu'] })
  doc = await run(doc, k, 'add_zone', { net: 'GND', layer: 'B.Cu' })
  doc = await run(doc, k, 'add_keepout', { name: 'antenna', rect: { at: [-14, -10], w: 8, h: 6 }, forbid: ['tracks', 'parts'] })
  doc = await run(doc, k, 'add_mounting_hole', { holes: [{ at: [17, 12], d: 3.2 }] })
  return doc
}

describe('import_kicad', () => {
  it('reads S-expressions with strings and escapes', () => {
    expect(parseSexpr('(a "b c" (d 1.5) "e\\"f")')).toEqual(['a', 'b c', ['d', '1.5'], 'e"f'])
    expect(() => parseSexpr('(a (b')).toThrow(/cut off/)
  })

  it('round-trips a Ket board through KiCad: every pad where it was', async () => {
    const k = new Kernel()
    const doc = await source(k)
    k.build(doc)
    const b = k.boardState(doc)!.board
    const text = writeKicadPcb(doc, b, k.boardState(doc)!.zones).text
    const back = await run(emptyDoc(), k, 'import_kicad', { data: text })
    const k2 = new Kernel()
    expect(k2.build(back).features.filter((f) => !f.ok)).toEqual([])
    const b2 = k2.boardState(back)!.board
    expect(b2.layers).toBe(4)
    expect(b2.pads.length).toBe(b.pads.length)
    for (const p of b.pads) {
      const q = b2.pads.find((x) => x.ref === p.ref && x.pin === p.pin)!
      expect(Math.hypot(p.center.x - q.center.x, p.center.y - q.center.y)).toBeLessThan(1e-3)
      expect(q.layers).toEqual(p.layers)
      expect(q.net).toBe(p.net)
    }
    expect(back.pcb!.components.find((c) => c.ref === 'R1')).toMatchObject({ side: 'bottom', value: '10k' })
    expect(back.pcb!.components.find((c) => c.ref === 'U1')!.footprint.pins['1']).toBe('VCC')
    expect(back.pcb!.tracks.find((t) => t.net === 'VCC')).toMatchObject({ layer: 'In1.Cu', points: [[0, 0], [5, 5], [10, 5]] })
    expect(back.pcb!.vias[0]).toMatchObject({ net: 'GND', at: [2, -8], span: ['F.Cu', 'In1.Cu'] })
    expect(back.pcb!.zones![0]).toMatchObject({ net: 'GND', layer: 'B.Cu' })
    expect(back.pcb!.keepouts![0]).toMatchObject({ name: 'antenna', forbid: ['tracks', 'parts'] })
    expect(back.pcb!.holes).toEqual([{ at: [17, 12], d: 3.2 }])
    expect(b2.outline.map((p) => [p.x, p.y]).sort()).toEqual(b.outline.map((p) => [p.x, p.y]).sort())
  }, 60_000)

  it('keeps edge fingers on B.Cu, normalizes via spans and unique keep-out names', async () => {
    const text = `(kicad_pcb (version 20241229) (general (thickness 1.6))
      (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
      (net 0 "") (net 1 "A")
      (gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts"))
      (footprint "x:EDGE" (layer "F.Cu") (at 10 10) (property "Reference" "J1")
        (pad "1" smd rect (at 0 0) (size 1 3) (layers "F.Cu") (net 1 "A"))
        (pad "2" connect rect (at 2 0) (size 1 3) (layers "B.Cu") (net "A")))
      (via (at 20 10) (size 0.6) (drill 0.3) (layers "B.Cu" "F.Cu") (net 1))
      (zone (net 0) (layer "F.Cu") (name "ant") (keepout (tracks not_allowed)) (polygon (pts (xy 1 1) (xy 3 1) (xy 3 3))))
      (zone (net 0) (layer "F.Cu") (name "ant") (keepout (vias not_allowed)) (polygon (pts (xy 5 1) (xy 7 1) (xy 7 3)))))`
    const r = readKicadPcb(text)
    const j1 = r.pcb.components[0]
    expect(j1.footprint.pads.map((p) => p.layer)).toEqual(['top', 'bottom'])
    // A net given by name alone still connects.
    expect(r.pcb.nets[0].pins.sort()).toEqual(['J1.1', 'J1.2'])
    expect(r.pcb.vias[0].span).toBeUndefined()
    expect(r.pcb.keepouts!.map((k) => k.name)).toEqual(['ant', 'ant_2'])
    // Back out: the finger stays on B.Cu, the via is a through via.
    const k = new Kernel()
    const doc = await run(emptyDoc(), k, 'import_kicad', { data: text })
    k.build(doc)
    const out = writeKicadPcb(doc, k.boardState(doc)!.board).text
    expect(out).toMatch(/\(pad "2" smd roundrect [^\n]*\(layers "B\.Cu" "B\.Paste" "B\.Mask"\)/)
    expect(out).not.toMatch(/via blind/)
  })

  it('names what it does not carry over, and refuses to overwrite a board', async () => {
    const k = new Kernel()
    const text = `(kicad_pcb (version 20241229) (general (thickness 1.6))
      (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
      (net 0 "") (net 1 "A")
      (gr_rect (start 0 0) (end 30 20) (layer "Edge.Cuts"))
      (gr_text "hello" (at 5 5) (layer "F.SilkS"))
      (footprint "x:R" (layer "F.Cu") (at 10 10) (property "Reference" "R?")
        (pad "1" smd roundrect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "A"))
        (pad "2" smd roundrect (at 1 0) (size 1 1) (layers "F.Cu") (net 1 "A")))
      (arc (start 2 2) (mid 3 3) (end 4 2) (width 0.25) (layer "F.Cu") (net 1))
      (foo bar))`
    const r = readKicadPcb(text)
    expect(r.counts).toMatchObject({ footprints: 1, nets: 1, tracks: 1 })
    expect(r.offset).toEqual([15, 10])
    const all = r.losses.join(' | ')
    expect(all).toMatch(/rounded and chamfered pad corners/)
    expect(all).toMatch(/silkscreen text/)
    expect(all).toMatch(/arc track/)
    expect(all).toMatch(/"R\?" are renamed/)
    expect(all).toMatch(/top-level "foo"/)
    // The arc became a polyline through its middle.
    expect(r.pcb.tracks[0].points.length).toBeGreaterThan(4)
    let doc = await run(emptyDoc(), k, 'import_kicad', { data: text })
    await expect(run(doc, k, 'import_kicad', { data: text })).rejects.toThrow(/has a board.*replace: true/)
    doc = await run(doc, k, 'import_kicad', { data: text, replace: true })
    expect(doc.pcb!.components.length).toBe(1)
    expect(() => readKicadPcb('(not_a_board)')).toThrow(/not a KiCad board/)
  })
})
