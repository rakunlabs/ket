import { describe, expect, it } from 'vitest'

import { applyOp, command, emptyDoc, localKernel, parseArgs, type Doc } from '../src/engine'
import { Kernel } from '../src/engine/kernel'
import { writeKicadPcb } from '../src/engine/pcb/kicad'
import './setup'

async function run(doc: Doc, k: Kernel, cmd: string, args: unknown): Promise<Doc> {
  const def = command(cmd)!
  let a = parseArgs(def, args)
  if (def.prepare) a = await def.prepare({ doc, kernel: localKernel(k, doc) }, a as never)
  return applyOp(doc, { cmd, args: a }).doc
}

type S = string | S[]

/** A small S-expression reader (KiCad's file syntax): lists, atoms and "strings". */
function parse(text: string): S {
  let i = 0
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  const read = (): S => {
    ws()
    if (text[i] === '(') {
      i++
      const list: S[] = []
      for (;;) {
        ws()
        if (text[i] === ')') {
          i++
          return list
        }
        if (i >= text.length) throw new Error('unbalanced parentheses')
        list.push(read())
      }
    }
    if (text[i] === '"') {
      i++
      let s = ''
      while (text[i] !== '"') {
        if (text[i] === '\\') i++
        s += text[i++]
        if (i >= text.length) throw new Error('unterminated string')
      }
      i++
      return s
    }
    const m = /^[^\s()"]+/.exec(text.slice(i))!
    i += m[0].length
    return m[0]
  }
  const v = read()
  ws()
  if (i !== text.length) throw new Error(`trailing text at ${i}`)
  return v
}

const kids = (s: S, tag: string): S[][] => (Array.isArray(s) ? (s.filter((x) => Array.isArray(x) && x[0] === tag) as S[][]) : [])
const one = (s: S, tag: string) => kids(s, tag)[0]

/** Where KiCad puts a footprint-local point: at + R(θ)·p in its y-down frame. */
function kicadWorld(fp: S[], p: [number, number]): [number, number] {
  const at = one(fp, 'at')!
  const [ax, ay, ang] = [Number(at[1]), Number(at[2]), Number(at[3] ?? 0)]
  const t = (ang * Math.PI) / 180
  const x = ax + p[0] * Math.cos(t) + p[1] * Math.sin(t)
  const y = ay - p[0] * Math.sin(t) + p[1] * Math.cos(t)
  // Back to Ket's y-up.
  return [x, -y]
}

async function board(k: Kernel) {
  let doc = emptyDoc()
  doc = await run(doc, k, 'set_board', { outline: { rect: { w: 40, h: 30 } } })
  doc = await run(doc, k, 'add_component', { footprint_name: 'soic8', ref: 'U1', at: [-6, 3], rotation: 30, pin_names: { 1: 'VCC', 8: 'GND' } })
  doc = await run(doc, k, 'add_component', { footprint_name: '0603', ref: 'R1', at: [8, -4], rotation: 90, side: 'bottom' })
  doc = await run(doc, k, 'add_component', { footprint_name: 'pinrow4', ref: 'J1', at: [10, 8] })
  doc = await run(doc, k, 'connect', { nets: [{ name: 'VCC', pins: ['U1.1', 'J1.1'] }, { name: 'GND', pins: ['U1.8', 'J1.2', 'R1.2'] }] })
  doc = await run(doc, k, 'add_track', { net: 'VCC', layer: 'F.Cu', points: [[0, 0], [5, 5]] })
  doc = await run(doc, k, 'add_via', { net: 'GND', at: [2, -8] })
  doc = await run(doc, k, 'add_zone', { net: 'GND', layer: 'B.Cu' })
  doc = await run(doc, k, 'add_keepout', { name: 'antenna', rect: { at: [-14, -10], w: 8, h: 6 }, forbid: ['tracks', 'pours'] })
  doc = await run(doc, k, 'add_mounting_hole', { holes: [{ at: [17, 12], d: 3.2 }] })
  doc = await run(doc, k, 'set_net_class', { name: 'power', track: 0.5, nets: ['VCC'] })
  return doc
}

describe('export_kicad', () => {
  it('writes a well-formed board with every object', async () => {
    const k = new Kernel()
    const doc = await board(k)
    k.build(doc)
    const r = writeKicadPcb(doc, k.boardState(doc)!.board)
    const root = parse(r.text) as S[]
    expect(root[0]).toBe('kicad_pcb')
    expect(one(root, 'version')![1]).toBe('20240108')
    expect(kids(root, 'footprint').length).toBe(4) // 3 parts + the mounting hole
    expect(kids(root, 'segment').length).toBe(1)
    expect(kids(root, 'via').length).toBe(1)
    const zones = kids(root, 'zone')
    expect(zones.length).toBe(2)
    expect(zones.filter((z) => one(z, 'keepout')).length).toBe(1)
    expect(kids(root, 'net').map((x) => x[2])).toEqual(['', 'VCC', 'GND'])
    // Every uuid is unique.
    const uuids = r.text.match(/\(uuid "[^"]+"\)/g)!
    expect(new Set(uuids).size).toBe(uuids.length)
    // The same board writes the same file.
    expect(writeKicadPcb(doc, k.boardState(doc)!.board).text).toBe(r.text)
    expect(r.notes.join(' ')).toMatch(/net classes/)
    expect(r.notes.join(' ')).toMatch(/press B/)
  }, 60_000)

  it('puts every pad where Ket has it, also rotated and on the bottom', async () => {
    const k = new Kernel()
    const doc = await board(k)
    k.build(doc)
    const b = k.boardState(doc)!.board
    const root = parse(writeKicadPcb(doc, b).text) as S[]
    let checked = 0
    for (const fp of kids(root, 'footprint')) {
      const ref = (kids(fp, 'property').find((p) => p[1] === 'Reference') ?? [])[2] as string
      for (const pad of kids(fp, 'pad')) {
        if (pad[1] === '') continue
        const at = one(pad, 'at')!
        const [x, y] = kicadWorld(fp, [Number(at[1]), Number(at[2])])
        const ket = b.pads.find((p) => p.ref === ref && p.pin === pad[1])!
        expect(x).toBeCloseTo(ket.center.x, 4)
        expect(y).toBeCloseTo(ket.center.y, 4)
        checked++
      }
      // Layer follows the side.
      if (ref === 'R1') expect(one(fp, 'layer')![1]).toBe('B.Cu')
    }
    expect(checked).toBe(8 + 2 + 4)
  }, 60_000)

  it('gives pads their nets and pin names', async () => {
    const k = new Kernel()
    const doc = await board(k)
    k.build(doc)
    const root = parse(writeKicadPcb(doc, k.boardState(doc)!.board).text) as S[]
    const u1 = kids(root, 'footprint').find((fp) => kids(fp, 'property').some((p) => p[1] === 'Reference' && p[2] === 'U1'))!
    const pad1 = kids(u1, 'pad').find((p) => p[1] === '1')!
    expect(one(pad1, 'net')).toEqual(['net', '1', 'VCC'])
    expect(one(pad1, 'pinfunction')).toEqual(['pinfunction', 'VCC'])
  }, 60_000)

  it('downloads through the command', async () => {
    const k = new Kernel()
    const doc = await board(k)
    k.build(doc)
    const files: string[] = []
    const def = command('export_kicad')!
    const r = (await def.run!({ doc, kernel: localKernel(k, doc), download: async (name) => (files.push(name), name) }, parseArgs(def, {}) as never)) as any
    expect(files).toEqual(['board.kicad_pcb'])
    expect(r.counts).toMatchObject({ footprints: 3, nets: 2, vias: 1, zones: 1, keepouts: 1 })
  }, 60_000)
})
