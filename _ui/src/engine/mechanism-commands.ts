// Mechanism commands: cams, geneva drives, belts and chains, a planetary
// gear set helper, and the interference sweep that steps the motion and
// reports parts that collide.

import { z } from 'zod'

import type { Feature } from './doc'
import { applyOp, define } from './registry'
import { common, expr, featureName, featureRef, plane, vec2, vec3 } from './schema'
import { compact, upsert } from './commands'

const replace = z.boolean().optional().describe('Replace the existing feature with this name (default false: fail if the name exists)')
const axis = z.enum(['X', 'Y', 'Z', '-X', '-Y', '-Z'])

define({
  name: 'cam',
  group: 'cad',
  kind: 'mutate',
  description:
    'Add a disc cam: a plate whose radius is base_r + lift(t) (+ the roller radius for a roller follower), t = cam angle 0..360 in degrees. Write lift as an expression in t, e.g. a cycloidal-ish rise "8*(1 - cos(t))/2" or dwell-rise-dwell with min/max. Drive it with rotation: "<param>". A follower body moves with it through a joint { body, kind: "cam", cam: "<this cam>" } in set_motion; it slides along follower_dir (from get_mechanisms, which also gives the follower_point to model the follower at, the stroke and the max pressure angle; keep that under 30°).',
  args: z.object({
    ...common,
    base_r: expr.describe('Base circle radius: the follower distance at zero lift'),
    lift: z.string().describe('Lift in mm as an expression of t (cam angle in degrees) and parameters; periodic over 360'),
    width: expr.describe('Thickness along the axis'),
    roller: expr.optional().describe('Roller follower radius (default 0: knife edge / flat tip)'),
    bore: expr.optional(),
    center: vec3.optional(),
    axis: axis.optional().describe('Default Z'),
    rotation: expr.optional().describe('Turn of the cam, degrees; drive with a parameter'),
    follower_at: expr.optional().describe('Where the follower sits, degrees in the cam plane (default 90: on +Y for a Z cam)'),
    replace,
  }),
  examples: [{ name: 'cam', base_r: 15, lift: '6*(1 - cos(t))/2', width: 6, bore: 5, roller: 3, rotation: 'crank' }],
  apply(doc, a) {
    const { replace: r, ...rest } = a
    return upsert(doc, compact({ ...rest, type: 'cam' }) as unknown as Feature, r)
  },
})

define({
  name: 'geneva',
  group: 'cad',
  kind: 'mutate',
  description:
    'Add an external geneva drive: part "drive" (a crank with a pin and a locking disc) and then part "wheel" (drive: "<drive name>"), which is built from the drive\'s fields and placed at distance toward its angle. Each drive turn indexes the wheel by 360/slots and locks it in between. Drive it with angle: "<param>" (degrees from the line of centers; 180 = pin away, wheel locked). Play and sweep_motion turn the wheel with the exact geneva law; get_mechanisms lists the sizes.',
  args: z.object({
    ...common,
    part: z.enum(['drive', 'wheel']),
    drive: featureRef.optional().describe('wheel: the drive feature'),
    slots: expr.optional().describe('drive: number of slots (3..18; 4 or 6 typical)'),
    distance: expr.optional().describe('drive: center distance between drive and wheel'),
    pin_d: expr.optional().describe('drive: pin diameter'),
    width: expr.optional().describe('drive: wheel thickness (the drive is 1.5× with its crank plate)'),
    center: vec3.optional().describe('drive: drive center'),
    axis: axis.optional(),
    toward: expr.optional().describe('drive: direction to the wheel, degrees in the drive plane (default 0)'),
    angle: expr.optional().describe('drive: drive angle; drive it with a parameter'),
    clearance: expr.optional().describe('drive: running clearance (default 0.2)'),
    bore: expr.optional(),
    replace,
  }),
  examples: [
    { name: 'gen_drive', part: 'drive', slots: 4, distance: 40, pin_d: 4, width: 5, bore: 5, angle: 'crank' },
    { name: 'gen_wheel', part: 'wheel', drive: 'gen_drive', bore: 5 },
  ],
  apply(doc, a) {
    const { replace: r, ...rest } = a
    if (a.part === 'wheel') {
      if (!a.drive) throw new Error('a geneva wheel needs drive: "<the geneva drive feature>"')
      const d = doc.features.find((f) => f.name === a.drive)
      if (!d || d.type !== 'geneva' || d.part !== 'drive') throw new Error(`"${a.drive}" is not a geneva drive; add one with part: "drive" first`)
      const other = doc.features.find((f) => f.type === 'geneva' && f.part === 'wheel' && f.drive === a.drive && f.name !== a.name)
      if (other) throw new Error(`"${a.drive}" already drives the wheel "${other.name}"`)
      return upsert(doc, compact({ name: a.name, note: a.note, color: a.color, opacity: a.opacity, hidden: a.hidden, type: 'geneva', part: 'wheel', drive: a.drive, bore: a.bore }) as unknown as Feature, r)
    }
    for (const k of ['slots', 'distance', 'pin_d', 'width'] as const) if (a[k] === undefined) throw new Error(`a geneva drive needs ${k}`)
    const { drive: _d, ...f } = rest
    return upsert(doc, compact({ ...f, type: 'geneva' }) as unknown as Feature, r)
  },
})

define({
  name: 'belt',
  group: 'cad',
  kind: 'mutate',
  description:
    'Add a belt or chain loop around pulleys in a plane (plane coordinates as in sketch, offset = the plane\'s mid-belt position). Each pulley: at (center), d (pitch diameter) or teeth with the belt pitch (d = pitch / sin(180°/teeth), GT2 pitch 2, #25 chain 6.35). The belt runs around the outside of every pulley. Pulleys with body: "<feature>" turn with it: when one of them turns (a gear, a joint), the others follow at the diameter ratio, same direction. get_mechanisms gives the length and, with pitch, the number of links (make it whole).',
  args: z.object({
    ...common,
    plane,
    offset: expr.optional(),
    pulleys: z.array(z.object({ at: vec2, d: expr.optional(), teeth: expr.optional(), body: featureRef.optional().describe('The pulley body, which turns with the belt') })).min(2),
    thickness: expr.describe('Belt thickness (centered on the pitch line)'),
    width: expr,
    pitch: expr.optional().describe('Tooth or chain pitch, mm'),
    replace,
  }),
  examples: [{ name: 'belt', plane: 'XY', offset: 5, pulleys: [{ at: [0, 0], teeth: 20, body: 'motor_pulley' }, { at: [80, 0], teeth: 40, body: 'big_pulley' }], thickness: 1.4, width: 6, pitch: 2 }],
  apply(doc, a) {
    const { replace: r, ...rest } = a
    for (const p of a.pulleys) if (p.body && !doc.features.some((f) => f.name === p.body)) throw new Error(`pulley body "${p.body}" does not exist`)
    return upsert(doc, compact({ ...rest, type: 'belt' }) as unknown as Feature, r)
  },
})

define({
  name: 'get_mechanisms',
  group: 'query',
  kind: 'query',
  description: 'Solved cams (stroke, max pressure angle, follower direction and contact point), geneva drives (crank and wheel radii, index per turn, where the wheel is) and belts (length, links, wrap angles and speed ratios), with warnings.',
  args: z.object({}),
  async run(ctx) {
    return ctx.kernel.mechanisms()
  },
})

// ── Planetary helper ────────────────────────────────────────────────────

interface PlanetSet {
  sun: number
  planet: number
  ring: number
  planets: number
  ratio: number
  error: number
}

/**
 * Tooth counts for a planetary set with the ring fixed, sun in, carrier
 * out: ratio = 1 + ring/sun. Rules: ring = sun + 2·planet (same module,
 * coaxial), (sun + ring) divisible by the planet count (equal spacing),
 * neighbouring planets clear: (planet + 2) < (sun + planet)·sin(π/n).
 */
export function planetarySets(ratio: number, opts: { minTeeth?: number; maxRing?: number; planets?: number }): PlanetSet[] {
  const minT = opts.minTeeth ?? 17
  const maxRing = opts.maxRing ?? 120
  const out: PlanetSet[] = []
  for (let sun = minT; sun <= maxRing; sun++) {
    for (let planet = minT; sun + 2 * planet <= maxRing; planet++) {
      const ring = sun + 2 * planet
      const r = 1 + ring / sun
      for (const n of opts.planets ? [opts.planets] : [3, 4, 5, 6]) {
        if ((sun + ring) % n) continue
        if (planet + 2 >= (sun + planet) * Math.sin(Math.PI / n)) continue
        out.push({ sun, planet, ring, planets: n, ratio: r, error: Math.abs(r - ratio) / ratio })
      }
    }
  }
  out.sort((a, b) => a.error - b.error || b.planets - a.planets || a.ring - b.ring)
  const seen = new Set<string>()
  return out.filter((s) => {
    const k = `${s.sun}/${s.planet}/${s.ring}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4

define({
  name: 'planetary',
  group: 'cad',
  kind: 'mutate',
  description:
    'Planetary gear set helper. Give the reduction ratio (ring fixed, sun input, carrier output: ratio = 1 + ring/sun) and module; it picks tooth counts that assemble (ring = sun + 2·planet, (sun + ring) divisible by the planet count, planets clear each other) and places the sun (driven by rotation), the planets meshing at equal angles, the internal ring, and a carrier plate. The carrier turns at 1/ratio and the planets orbit with it when you press Play (the carrier angle is a parameter "<name>_carrier_angle" = rotation/ratio). Pass sun/planet/ring/planets to force counts; pass dry_run: true to only list candidate sets.',
  args: z.object({
    name: featureName.describe('Prefix: <name>_sun, <name>_planet1.., <name>_ring, <name>_carrier'),
    ratio: z.number().gt(2).optional().describe('Wanted reduction (3..12 is typical for one stage)'),
    module: expr,
    width: expr,
    sun: z.number().int().optional(),
    planet: z.number().int().optional(),
    ring: z.number().int().optional(),
    planets: z.number().int().min(2).max(8).optional(),
    min_teeth: z.number().int().min(6).optional().describe('Smallest gear (default 17: no undercut at 20°)'),
    max_ring: z.number().int().optional().describe('Largest ring (default 120)'),
    center: vec3.optional(),
    axis: axis.optional(),
    rotation: expr.optional().describe('Sun rotation; drive it with a parameter, e.g. "crank"'),
    bore: expr.optional().describe('Sun and planet bore'),
    rim: expr.optional().describe('Ring outside diameter'),
    carrier: z.boolean().optional().describe('Add the carrier plate (default true)'),
    dry_run: z.boolean().optional().describe('Only return the candidate sets'),
  }),
  examples: [{ name: 'stage1', ratio: 5, module: 1, width: 8, rotation: 'crank' }],
  apply(doc, a) {
    let pick: PlanetSet
    let candidates: PlanetSet[] = []
    if (a.sun && a.planet) {
      const ring = a.ring ?? a.sun + 2 * a.planet
      if (ring !== a.sun + 2 * a.planet) throw new Error(`ring must be sun + 2·planet = ${a.sun + 2 * a.planet} for a coaxial set of one module`)
      const n = a.planets ?? 3
      if ((a.sun + ring) % n) throw new Error(`(sun + ring) = ${a.sun + ring} is not divisible by ${n} planets: they cannot be spaced equally; pick another count`)
      if (a.planet + 2 >= (a.sun + a.planet) * Math.sin(Math.PI / n)) throw new Error(`${n} planets of ${a.planet} teeth touch each other; use fewer planets or a larger sun`)
      pick = { sun: a.sun, planet: a.planet, ring, planets: n, ratio: 1 + ring / a.sun, error: 0 }
    } else {
      if (!a.ratio) throw new Error('give ratio, or sun and planet tooth counts')
      candidates = planetarySets(a.ratio, { minTeeth: a.min_teeth, maxRing: a.max_ring, planets: a.planets })
      if (!candidates.length) throw new Error(`no set gives ratio ${a.ratio} within ring ≤ ${a.max_ring ?? 120} and teeth ≥ ${a.min_teeth ?? 17}; raise max_ring or lower min_teeth (ratios under ~3 need large suns)`)
      pick = candidates[0]
    }
    const summary = `planetary ${a.name}: sun ${pick.sun}, ${pick.planets}× planet ${pick.planet}, ring ${pick.ring}, ratio ${r4(pick.ratio)}${pick.error > 1e-9 ? ` (${(pick.error * 100).toFixed(2)}% off ${a.ratio})` : ''}`
    if (a.dry_run) {
      return { doc, summary: summary + '; candidates: ' + candidates.slice(0, 8).map((c) => `${c.sun}/${c.planet}/${c.ring}×${c.planets} → ${r4(c.ratio)}`).join(', ') }
    }
    const p = `${a.name}_carrier_angle`
    const rot = a.rotation ?? 0
    const steps: { cmd: string; args: unknown }[] = [
      { cmd: 'set_parameters', args: { parameters: [{ name: p, expr: typeof rot === 'number' ? rot / pick.ratio : `(${rot}) / ${r4(pick.ratio)}`, description: `carrier angle of ${a.name} (sun / ${r4(pick.ratio)})` }] } },
      { cmd: 'gear', args: compact({ name: `${a.name}_sun`, kind: 'spur', teeth: pick.sun, module: a.module, width: a.width, bore: a.bore, center: a.center, axis: a.axis, rotation: rot }) },
    ]
    // Each planet meshes with the sun at carrier + k·360/n; the solver places it and phases its teeth.
    for (let k = 0; k < pick.planets; k++) {
      steps.push({ cmd: 'gear', args: compact({ name: `${a.name}_planet${k + 1}`, kind: 'spur', teeth: pick.planet, module: a.module, width: a.width, bore: a.bore, mesh: { with: `${a.name}_sun`, angle: `${p} + ${(k * 360) / pick.planets}` } }) })
    }
    // The ring meshes with planet 1 on the sun side, so it lands on the sun's axis.
    steps.push({ cmd: 'gear', args: compact({ name: `${a.name}_ring`, kind: 'internal', teeth: pick.ring, module: a.module, width: a.width, rim: a.rim, mesh: { with: `${a.name}_planet1`, angle: `${p} + 180` } }) })
    let next = doc
    for (const s of steps) next = applyOp(next, s).doc
    const notes: string[] = []
    if (a.carrier !== false) {
      if (a.axis && a.axis !== 'Z') notes.push('carrier plate only for axis Z; add your own and give it a rotate joint at 1/ratio')
      else {
        const c = a.center ?? [0, 0, 0]
        const ac = `${a.module} * ${(pick.sun + pick.planet) / 2}`
        const top = `${c[2]} + (${a.width}) / 2 + 0.6`
        const plate = { name: `${a.name}_carrier_plate`, r: `${ac} + ${a.module} * ${pick.planet / 2 + 1.5}`, h: 3, translate: [c[0], c[1], top] }
        next = applyOp(next, { cmd: 'cylinder', args: plate }).doc
        const tools: string[] = []
        if (a.bore !== undefined) {
          for (let k = 0; k < pick.planets; k++) {
            const ang = `${p} + ${(k * 360) / pick.planets}`
            const pin = `${a.name}_carrier_pin${k + 1}`
            next = applyOp(next, {
              cmd: 'cylinder',
              args: { name: pin, r: `(${a.bore}) / 2 - 0.15`, h: `(${a.width}) + 1.2`, translate: [`${c[0]} + ${ac} * cos(${ang})`, `${c[1]} + ${ac} * sin(${ang})`, `${c[2]} - (${a.width}) / 2 - 0.6`] },
            }).doc
            tools.push(pin)
          }
        }
        if (tools.length) next = applyOp(next, { cmd: 'boolean', args: { name: `${a.name}_carrier`, op: 'union', target: plate.name, tools, opacity: 0.35 } }).doc
        else next = applyOp(next, { cmd: 'transform', args: { name: `${a.name}_carrier`, target: plate.name, opacity: 0.35 } }).doc
        const drive = typeof rot === 'string' && /^[A-Za-z_]\w*$/.test(rot.trim()) ? rot.trim() : undefined
        if (drive) {
          const joints = (next.motion?.joints ?? []).filter((j) => j.body !== `${a.name}_carrier`)
          joints.push({ body: `${a.name}_carrier`, kind: 'rotate', axis: [0, 0, 1], origin: c, rate: r4(1 / pick.ratio) })
          next = applyOp(next, { cmd: 'set_motion', args: { joints } }).doc
        } else notes.push(`the carrier turns at 1/${r4(pick.ratio)} of the sun; add a rotate joint for it (rotation is not a plain parameter)`)
      }
    }
    return { doc: next, summary: summary + `; carrier angle parameter ${p}` + (notes.length ? `; ${notes.join('; ')}` : '') }
  },
})

define({
  name: 'sweep_motion',
  group: 'query',
  kind: 'query',
  description:
    'Interference check through the motion (like Onshape/Fusion interference during a motion study): steps the driven parameter from..to (default the current value + 360), poses every moving body (gears, joints, cams, geneva, belts) and checks each pair with at least one moving: a fast mesh test finds touching pairs, the first contact of a pair is confirmed with an exact solid intersection. Returns for each colliding pair the first and last parameter value it overlaps, the overlap volume at first contact and the deepest penetration (mm) with where it happens. Skip intended contacts (a belt on its pulleys, a shaft in its bearing) with ignore; narrow with bodies on big models.',
  args: z.object({
    from: z.number().optional(),
    to: z.number().optional(),
    steps: z.number().int().min(1).max(720).optional().describe('Default 72 (5° over a turn)'),
    bodies: z.array(featureRef).optional().describe('Only these bodies (default all)'),
    ignore: z.array(z.tuple([featureRef, featureRef])).optional().describe('Pairs allowed to touch'),
    min_volume: z.number().positive().optional().describe('Overlap below this (mm³) is not reported (default 0.001)'),
  }),
  async run(ctx, a) {
    return ctx.kernel.sweep(a)
  },
})
