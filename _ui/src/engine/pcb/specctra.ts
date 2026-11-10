// Specctra DSN export and SES import for Freerouting. Follows the
// conventions Flamingo verified (MIT, github.com/cheewee2000/flamingo-pcb):
// µm integer coordinates with (resolution um 1), y-up passes through,
// bottom parts placed "back" (Specctra mirrors x), vias named V_<drill>_<dia>.

import type { Pcb, Track, Via } from '../doc'
import type { ResolvedBoard } from './board'
import { DEFAULT_CLASS } from './board'

const um = (mm: number) => Math.round(mm * 1000) + 0
const q = (s: string) => (s === '' || /[\s()"-]/.test(s) ? `"${s.replace(/"/g, '')}"` : s)

function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function exportDSN(pcb: Pcb, b: ResolvedBoard, opts: { skip?: Set<string> } = {}): string {
  const layers = b.layers === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu']
  const def = b.classes.get('default') ?? DEFAULT_CLASS
  const out: string[] = []
  out.push('(pcb board', '  (parser (string_quote ") (space_in_quoted_tokens on) (host_cad ket) (host_version 1))', '  (resolution um 1)', '  (unit um)')

  out.push('  (structure')
  for (const l of layers) out.push(`    (layer ${l} (type signal))`)
  const ring = [...b.outline, b.outline[0]].flatMap((p) => [um(p.x), um(p.y)])
  out.push(`    (boundary (path pcb 0 ${ring.join(' ')}))`)
  for (const c of b.cutouts) {
    const coords = c.flatMap((p) => [um(p.x), um(p.y)]).join(' ')
    for (const l of layers) out.push(`    (keepout "" (polygon ${l} 0 ${coords}))`)
  }
  for (const h of b.holes) {
    const r = h.d / 2 + def.clearance
    const coords: number[] = []
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 2 * Math.PI
      coords.push(um(h.at.x + r * Math.cos(a)), um(h.at.y + r * Math.sin(a)))
    }
    for (const l of layers) out.push(`    (keepout "" (polygon ${l} 0 ${coords.join(' ')}))`)
  }
  const viaNames = new Map<string, string>()
  for (const c of b.classes.values()) viaNames.set(c.name, `V_${um(c.via_drill)}_${um(c.via_diameter)}`)
  out.push(`    (via ${[...new Set(viaNames.values())].join(' ')})`)
  out.push(`    (rule (width ${um(def.track)}) (clearance ${um(def.clearance)}))`)
  out.push('  )')

  // Images: one per distinct footprint geometry.
  const imageOf = new Map<string, string>()
  const images = new Map<string, (typeof b.components)[number]>()
  for (const c of b.components) {
    const id = `${c.footprint.name.replace(/[^\w.-]/g, '_').slice(0, 40)}_${hash(JSON.stringify(c.footprint.pads))}`
    imageOf.set(c.ref, id)
    if (!images.has(id)) images.set(id, c)
  }

  out.push('  (placement')
  for (const [id] of images) {
    out.push(`    (component ${q(id)}`)
    for (const c of b.components)
      if (imageOf.get(c.ref) === id) out.push(`      (place ${q(c.ref)} ${um(c.at.x)} ${um(c.at.y)} ${c.side === 'bottom' ? 'back' : 'front'} ${Math.round(c.rotation * 1000) / 1000})`)
    out.push('    )')
  }
  out.push('  )')

  const stacks = new Map<string, string>()
  out.push('  (library')
  for (const [id, c] of images) {
    out.push(`    (image ${q(id)}`)
    for (const pad of c.footprint.pads) {
      const tag = pad.layer === 'through' ? 'TH' : pad.layer === 'top' ? 'F' : 'B'
      const padLayers = pad.layer === 'through' ? layers : [pad.layer === 'top' ? 'F.Cu' : 'B.Cu']
      let name: string
      let shape: (l: string) => string
      const rotated = Math.abs(((pad.rotation % 180) + 180) % 180) > 1e-6
      if (pad.shape === 'circle') {
        name = `c_${um(pad.w)}_${tag}`
        shape = (l) => `(circle ${l} ${um(pad.w)})`
      } else if (pad.shape === 'polygon' || rotated) {
        // Use the pad's rotated corner polygon.
        const a = (pad.rotation * Math.PI) / 180
        const pts =
          pad.shape === 'polygon' && pad.polygon?.length
            ? pad.polygon
            : [
                { x: -pad.w / 2, y: -pad.h / 2 },
                { x: pad.w / 2, y: -pad.h / 2 },
                { x: pad.w / 2, y: pad.h / 2 },
                { x: -pad.w / 2, y: pad.h / 2 },
              ]
        const coords = pts.map((p) => `${um(p.x * Math.cos(a) - p.y * Math.sin(a))} ${um(p.x * Math.sin(a) + p.y * Math.cos(a))}`).join(' ')
        name = `p_${hash(coords + tag)}_${tag}`
        shape = (l) => `(polygon ${l} 0 ${coords})`
      } else if (pad.shape === 'rect') {
        name = `r_${um(pad.w)}x${um(pad.h)}_${tag}`
        shape = (l) => `(rect ${l} ${um(-pad.w / 2)} ${um(-pad.h / 2)} ${um(pad.w / 2)} ${um(pad.h / 2)})`
      } else {
        const w = Math.min(um(pad.w), um(pad.h))
        const half = Math.round((Math.max(um(pad.w), um(pad.h)) - w) / 2)
        name = `o_${um(pad.w)}x${um(pad.h)}_${tag}`
        shape = (l) => `(path ${l} ${w} ${pad.w >= pad.h ? `${-half} 0 ${half} 0` : `0 ${-half} 0 ${half}`})`
      }
      if (pad.drill) name += `_d${um(pad.drill.d)}`
      stacks.set(name, padLayers.map((l) => `(shape ${shape(l)})`).join(' '))
      out.push(`      (pin ${name} ${q(pad.number)} ${um(pad.at.x)} ${um(pad.at.y)})`)
    }
    out.push('    )')
  }
  for (const [name, forms] of stacks) out.push(`    (padstack ${name} ${forms} (attach off))`)
  for (const c of b.classes.values()) {
    const dia = um(c.via_diameter)
    out.push(`    (padstack V_${um(c.via_drill)}_${dia} ${layers.map((l) => `(shape (circle ${l} ${dia}))`).join(' ')} (attach off))`)
  }
  out.push('  )')

  out.push('  (network')
  const routable = pcb.nets.filter((n) => n.pins.length >= 2 && !opts.skip?.has(n.name))
  for (const n of routable) {
    const pins = n.pins.map((p) => {
      const i = p.indexOf('.')
      return `${q(p.slice(0, i))}-${q(p.slice(i + 1))}`
    })
    out.push(`    (net ${q(n.name)} (pins ${pins.join(' ')}))`)
  }
  const byClass = new Map<string, string[]>()
  for (const n of routable) {
    const c = n.class && b.classes.has(n.class) ? n.class : 'default'
    if (!byClass.has(c)) byClass.set(c, [])
    byClass.get(c)!.push(q(n.name))
  }
  for (const [name, members] of byClass) {
    const c = b.classes.get(name)!
    out.push(`    (class ${q(name)} ${members.join(' ')} (circuit (use_via V_${um(c.via_drill)}_${um(c.via_diameter)})) (rule (width ${um(c.track)}) (clearance ${um(c.clearance)})))`)
  }
  out.push('  )')

  // Existing copper stays as protected wiring.
  if (pcb.tracks.length || pcb.vias.length) {
    out.push('  (wiring')
    for (const t of pcb.tracks) out.push(`    (wire (path ${t.layer} ${um(t.width)} ${t.points.map((p) => `${um(p[0])} ${um(p[1])}`).join(' ')}) (net ${q(t.net)}) (type protect))`)
    for (const v of pcb.vias) out.push(`    (via V_${um(v.drill)}_${um(v.diameter)} ${um(v.at[0])} ${um(v.at[1])} (net ${q(v.net)}) (type protect))`)
    out.push('  )')
  }

  out.push(')', '')
  return out.join('\n')
}

type S = string | S[]

function parseS(src: string): S[] {
  const toks = src.match(/"[^"]*"|[()]|[^\s()"]+/g) ?? []
  let i = 0
  const list = (): S[] => {
    const out: S[] = []
    while (i < toks.length) {
      const t = toks[i++]
      if (t === '(') out.push(list())
      else if (t === ')') return out
      else out.push(t.startsWith('"') ? t.slice(1, -1) : t)
    }
    return out
  }
  while (i < toks.length && toks[i] !== '(') i++
  i++
  return list()
}

const kids = (l: S[], name: string) => l.filter((e): e is S[] => Array.isArray(e) && e[0] === name)

/** Freerouting's session → tracks and vias (only the new, unprotected ones). */
export function importSES(ses: string, known: Set<string>): { tracks: Track[]; vias: Via[] } {
  const root = parseS(ses)
  const routes = kids(root, 'routes')[0]
  if (!routes) throw new Error('the autorouter answered no routes')
  const res = kids(routes, 'resolution')[0]
  const unit = { um: 0.001, mm: 1, mil: 0.0254, inch: 25.4 }[(res?.[1] as string) ?? 'um'] ?? 0.001
  const factor = unit / Number(res?.[2] ?? 1)
  const netOut = kids(routes, 'network_out')[0]
  const tracks: Track[] = []
  const vias: Via[] = []
  if (!netOut) return { tracks, vias }
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  for (const net of kids(netOut, 'net')) {
    const name = net[1] as string
    if (!known.has(name)) continue
    for (const w of kids(net, 'wire')) {
      if (kids(w, 'type').some((t) => t[1] === 'protect')) continue
      const path = kids(w, 'path')[0]
      if (!path) continue
      const nums = path.slice(3).map((x) => Number(x) * factor)
      const points: [number, number][] = []
      for (let i = 0; i + 1 < nums.length; i += 2) points.push([r3(nums[i]), r3(nums[i + 1])])
      if (points.length >= 2) tracks.push({ net: name, layer: path[1] as Track['layer'], width: r3(Number(path[2]) * factor), points })
    }
    for (const v of kids(net, 'via')) {
      if (kids(v, 'type').some((t) => t[1] === 'protect')) continue
      const m = /^V_(\d+)_(\d+)$/.exec(v[1] as string)
      vias.push({ net: name, at: [r3(Number(v[2]) * factor), r3(Number(v[3]) * factor)], drill: m ? Number(m[1]) / 1000 : 0.3, diameter: m ? Number(m[2]) / 1000 : 0.6 })
    }
  }
  return { tracks, vias }
}
